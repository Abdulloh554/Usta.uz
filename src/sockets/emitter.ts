import type { Server } from 'socket.io';
import { logger } from '../config/logger';
import { room, type SocketEvent } from './events';

/**
 * Services emit through this shim rather than importing the Socket.IO server
 * directly. That keeps `sockets/index.ts` free to import services (it needs
 * them to handle incoming events) without a circular dependency, and it makes
 * every service unit-testable with no socket server running at all.
 */
let io: Server | null = null;

export const registerSocketServer = (server: Server): void => {
  io = server;
};

/** Test helper — drops the registered server so emits become no-ops again. */
export const clearSocketServer = (): void => {
  io = null;
};

export const emitToUser = (userId: string, event: SocketEvent, payload: unknown): void => {
  if (!io) {
    logger.debug('Socket emit skipped — no server registered', { event, userId });
    return;
  }
  io.to(room.user(userId)).emit(event, payload);
};

export const emitToChat = (chatId: string, event: SocketEvent, payload: unknown): void => {
  io?.to(room.chat(chatId)).emit(event, payload);
};

export const emitToOrder = (orderId: string, event: SocketEvent, payload: unknown): void => {
  io?.to(room.order(orderId)).emit(event, payload);
};

export const isSocketReady = (): boolean => io !== null;
