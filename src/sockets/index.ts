import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { createQueueConnection } from '../config/redis';
import { verifyAccessToken } from '../common/utils/token';
import { isRevoked } from '../common/middlewares/auth.middleware';
import { UserRole, type AuthenticatedUser } from '../common/types';
import { canAccessChat, markRead } from '../modules/chat/chat.service';
import { setOnline } from '../modules/user/user.service';
import { resumableOfferFor } from '../modules/matching/matching.service';
import { registerSocketServer } from './emitter';
import { room, SocketEvent, type TypingPayload } from './events';

type AuthedSocket = Socket & { user: AuthenticatedUser };

export const initSocketServer = (httpServer: HttpServer): Server => {
  const io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : true,
      credentials: true,
    },
    // Mobile networks drop idle connections; a shorter interval detects a dead
    // client before a job offer is wasted on it.
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  /**
   * The Redis adapter makes rooms work across API instances — without it a
   * client connected to replica A would never receive an event emitted on B.
   */
  const pub = createQueueConnection('socket-pub');
  const sub = createQueueConnection('socket-sub');
  void Promise.all([pub.connect().catch(() => undefined), sub.connect().catch(() => undefined)]).then(
    () => {
      io.adapter(createAdapter(pub, sub));
      logger.info('Socket.IO Redis adapter attached');
    },
  );

  io.use((socket, next) => {
    const token =
      (socket.handshake.auth as { token?: string } | undefined)?.token ??
      socket.handshake.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      next(new Error('Authentication token is missing'));
      return;
    }

    let payload: ReturnType<typeof verifyAccessToken>;
    try {
      payload = verifyAccessToken(token);
    } catch {
      next(new Error('Authentication token is invalid'));
      return;
    }

    // A blocked or signed-out user's old token must not reconnect either.
    void isRevoked(payload).then((revoked) => {
      if (revoked) {
        next(new Error('This session has been ended'));
        return;
      }
      (socket as AuthedSocket).user = { id: payload.sub, role: payload.role };
      next();
    });
  });

  io.on('connection', (socket) => {
    const { user } = socket as AuthedSocket;

    // Every device the user is signed in on shares one room, so an event
    // reaches their phone and tablet alike.
    void socket.join(room.user(user.id));

    if (user.role === UserRole.MASTER) {
      void setOnline(user.id, true).catch((error: unknown) => {
        logger.warn('Could not mark a pro online', {
          userId: user.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });

      // A pro who reconnects mid-offer must see it again — the phone may have
      // rung while the app was closed.
      // It carries the whole card — title, client, fee — not just the id, so the
      // offer screen can render it without a second request.
      void resumableOfferFor(user.id)
        .then((offer) => {
          if (offer) socket.emit(SocketEvent.ORDER_OFFER, offer);
        })
        .catch(() => undefined);
    }

    socket.emit(SocketEvent.CONNECTED, { userId: user.id, role: user.role });

    socket.on(SocketEvent.CHAT_JOIN, async (payload: { chatId?: string }) => {
      const chatId = payload?.chatId;
      if (!chatId) return;
      // Room names are guessable, so membership is checked rather than trusted.
      if (!(await canAccessChat(chatId, user.id))) {
        socket.emit(SocketEvent.ERROR, { event: SocketEvent.CHAT_JOIN, message: 'Forbidden' });
        return;
      }
      await socket.join(room.chat(chatId));
    });

    socket.on(SocketEvent.CHAT_LEAVE, (payload: { chatId?: string }) => {
      if (payload?.chatId) void socket.leave(room.chat(payload.chatId));
    });

    socket.on(SocketEvent.CHAT_TYPING, (payload: Partial<TypingPayload>) => {
      if (!payload?.chatId) return;
      socket.to(room.chat(payload.chatId)).emit(SocketEvent.CHAT_TYPING_STATE, {
        chatId: payload.chatId,
        userId: user.id,
        isTyping: Boolean(payload.isTyping),
      });
    });

    socket.on(SocketEvent.CHAT_READ, async (payload: { chatId?: string }) => {
      if (!payload?.chatId) return;
      await markRead(payload.chatId, user.id).catch(() => undefined);
    });

    socket.on('disconnect', (reason) => {
      logger.debug('Socket disconnected', { userId: user.id, reason });

      if (user.role === UserRole.MASTER) {
        // Only the last device going away takes the pro offline; otherwise
        // closing one of two open sessions would stop their offers.
        void io
          .in(room.user(user.id))
          .fetchSockets()
          .then((sockets) => {
            if (sockets.length === 0) return setOnline(user.id, false);
            return undefined;
          })
          .catch(() => undefined);
      }
    });
  });

  registerSocketServer(io);
  logger.info('Socket.IO ready');
  return io;
};
