import {
  canAccessChat,
  getChat,
  getChatByOrder,
  listChats,
  listMessages,
  markRead,
  sendMessage,
  unreadTotal,
} from '../../src/modules/chat/chat.service';
import { Chat, Message, MessageKind } from '../../src/modules/chat/chat.model';
import { ForbiddenError, NotFoundError } from '../../src/common/errors/ApiError';
import { makeClient, makeMaster, makeOrder } from '../helpers/factories';

const openChat = async () => {
  const client = await makeClient();
  const master = await makeMaster();
  const order = await makeOrder(client._id);
  const chat = await Chat.create({
    participants: [client._id, master._id],
    order: order._id,
  });
  return { client, master, order, chat, chatId: chat.id as string };
};

describe('chat service', () => {
  describe('sendMessage', () => {
    it('stores the message, moves the chat to the top and counts it unread for the other side', async () => {
      const { client, master, chatId } = await openChat();

      const message = await sendMessage(chatId, master.id as string, {
        text: 'Hello! I accepted the job, I will be there in 30 minutes.',
      });

      expect(message.text).toContain('30 minutes');
      // The sender has necessarily read their own message.
      expect(message.readBy.map(String)).toEqual([master.id]);

      const reloaded = await Chat.findById(chatId);
      expect(reloaded!.lastMessage!.toString()).toBe(String(message._id));
      expect(reloaded!.lastMessageAt).toBeDefined();
      expect(reloaded!.unread.get(client.id as string)).toBe(1);
      expect(reloaded!.unread.get(master.id as string)).toBeUndefined();
    });

    it('accumulates unread across several messages', async () => {
      const { client, master, chatId } = await openChat();

      await sendMessage(chatId, master.id as string, { text: 'On my way' });
      await sendMessage(chatId, master.id as string, { text: 'Five minutes' });
      await sendMessage(chatId, master.id as string, { text: 'Outside now' });

      expect(await unreadTotal(client.id as string)).toBe(3);
      expect(await unreadTotal(master.id as string)).toBe(0);
    });

    it('keeps a non-participant out', async () => {
      const { chatId } = await openChat();
      const stranger = await makeClient();

      await expect(sendMessage(chatId, stranger.id as string, { text: 'hi' })).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('rejects an empty text message at the model level', async () => {
      const { master, chatId } = await openChat();
      await expect(sendMessage(chatId, master.id as string, { text: '   ' })).rejects.toThrow();
    });

    it('rejects an image message with no attachment', async () => {
      const { master, chatId } = await openChat();
      await expect(
        sendMessage(chatId, master.id as string, { kind: MessageKind.IMAGE }),
      ).rejects.toThrow();
    });

    it('throws for a chat that does not exist', async () => {
      const user = await makeClient();
      await expect(
        sendMessage('507f1f77bcf86cd799439011', user.id as string, { text: 'hi' }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('markRead', () => {
    it('clears the badge and marks every message read', async () => {
      const { client, master, chatId } = await openChat();
      await sendMessage(chatId, master.id as string, { text: 'On my way' });
      await sendMessage(chatId, master.id as string, { text: 'Nearly there' });

      await markRead(chatId, client.id as string);

      expect(await unreadTotal(client.id as string)).toBe(0);
      const unreadLeft = await Message.countDocuments({
        chat: chatId,
        readBy: { $ne: client._id },
      });
      expect(unreadLeft).toBe(0);
    });

    it('keeps a non-participant out', async () => {
      const { chatId } = await openChat();
      const stranger = await makeClient();
      await expect(markRead(chatId, stranger.id as string)).rejects.toThrow(ForbiddenError);
    });
  });

  describe('listMessages', () => {
    it('pages newest first', async () => {
      const { client, master, chatId } = await openChat();
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sendMessage(chatId, master.id as string, { text: `Message ${i}` });
      }

      const page = await listMessages(chatId, client.id as string, 1, 2);

      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(5);
      expect(page.pages).toBe(3);
      expect(page.items[0]!.text).toBe('Message 4');
    });

    it('keeps a non-participant out', async () => {
      const { chatId } = await openChat();
      const stranger = await makeClient();
      await expect(listMessages(chatId, stranger.id as string, 1, 10)).rejects.toThrow(ForbiddenError);
    });
  });

  describe('lookups', () => {
    it('finds a chat by its job', async () => {
      const { client, order, chatId } = await openChat();
      const found = await getChatByOrder(order.id as string, client.id as string);
      expect(found.id).toBe(chatId);
    });

    it('lists a user’s chats', async () => {
      const { client } = await openChat();
      expect(await listChats(client.id as string)).toHaveLength(1);
    });

    it('keeps a stranger out of a chat detail', async () => {
      const { chatId } = await openChat();
      const stranger = await makeClient();
      await expect(getChat(chatId, stranger.id as string)).rejects.toThrow(ForbiddenError);
    });

    it('gates socket room membership on real participation', async () => {
      const { client, chatId } = await openChat();
      const stranger = await makeClient();

      expect(await canAccessChat(chatId, client.id as string)).toBe(true);
      expect(await canAccessChat(chatId, stranger.id as string)).toBe(false);
      expect(await canAccessChat('507f1f77bcf86cd799439011', client.id as string)).toBe(false);
    });
  });
});
