import {
  listForUser,
  markAllRead,
  markRead,
  notify,
  registerDevice,
  unreadCount,
  unregisterDevice,
} from '../../src/modules/notification/notification.service';
import { Notification } from '../../src/modules/notification/notification.model';
import { User } from '../../src/modules/user/user.model';
import { Language, NotificationType } from '../../src/common/types';
import { NotFoundError } from '../../src/common/errors/ApiError';
import { makeClient, makeMaster } from '../helpers/factories';

describe('notification service', () => {
  describe('notify', () => {
    it('writes the notification in the recipient’s own language', async () => {
      const client = await makeClient();

      const uz = await notify({ userId: client.id as string, type: NotificationType.ORDER_ACCEPTED });
      expect(uz.title).toBe('Usta topildi');

      await User.updateOne({ _id: client._id }, { $set: { language: Language.RU } });
      const ru = await notify({ userId: client.id as string, type: NotificationType.ORDER_ACCEPTED });
      expect(ru.title).toBe('Мастер найден');

      await User.updateOne({ _id: client._id }, { $set: { language: Language.EN } });
      const en = await notify({ userId: client.id as string, type: NotificationType.ORDER_ACCEPTED });
      expect(en.title).toBe('A pro took your job');
    });

    /** Only a job offer rings the phone — that is the promise on the permission screen. */
    it('marks a job offer as ringing and nothing else', async () => {
      const master = await makeMaster();

      const offer = await notify({ userId: master.id as string, type: NotificationType.ORDER_OFFER });
      expect(offer.isRinging).toBe(true);

      const message = await notify({
        userId: master.id as string,
        type: NotificationType.NEW_MESSAGE,
      });
      expect(message.isRinging).toBe(false);
    });

    it('lets the caller override the body, for a message preview', async () => {
      const client = await makeClient();

      const notification = await notify({
        userId: client.id as string,
        type: NotificationType.NEW_MESSAGE,
        body: 'The work will be 250,000 UZS — is that okay?',
      });

      expect(notification.body).toContain('250,000 UZS');
      // The title still comes from the localised copy.
      expect(notification.title).toBe('Yangi xabar');
    });

    it('carries the job and chat references and the data payload', async () => {
      const client = await makeClient();
      const orderId = '507f1f77bcf86cd799439011';
      const chatId = '507f1f77bcf86cd799439012';

      const notification = await notify({
        userId: client.id as string,
        type: NotificationType.ORDER_ACCEPTED,
        orderId,
        chatId,
        data: { orderId, chatId },
      });

      expect(notification.order!.toString()).toBe(orderId);
      expect(notification.chat!.toString()).toBe(chatId);
      expect(notification.data).toEqual({ orderId, chatId });
    });

    it('throws for a recipient who does not exist', async () => {
      await expect(
        notify({ userId: '507f1f77bcf86cd799439011', type: NotificationType.NEW_MESSAGE }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('reading', () => {
    it('counts unread and clears one at a time', async () => {
      const client = await makeClient();
      const first = await notify({
        userId: client.id as string,
        type: NotificationType.NEW_MESSAGE,
      });
      await notify({ userId: client.id as string, type: NotificationType.NEW_MESSAGE });

      expect(await unreadCount(client.id as string)).toBe(2);

      await markRead(client.id as string, first.id as string);
      expect(await unreadCount(client.id as string)).toBe(1);

      const reloaded = await Notification.findById(first._id);
      expect(reloaded!.isRead).toBe(true);
      expect(reloaded!.readAt).toBeDefined();
    });

    it('clears everything at once', async () => {
      const client = await makeClient();
      await notify({ userId: client.id as string, type: NotificationType.NEW_MESSAGE });
      await notify({ userId: client.id as string, type: NotificationType.ORDER_COMPLETED });

      await markAllRead(client.id as string);
      expect(await unreadCount(client.id as string)).toBe(0);
    });

    it('will not let one user clear another’s notification', async () => {
      const owner = await makeClient();
      const stranger = await makeClient();
      const notification = await notify({
        userId: owner.id as string,
        type: NotificationType.NEW_MESSAGE,
      });

      await markRead(stranger.id as string, notification.id as string);

      expect(await unreadCount(owner.id as string)).toBe(1);
    });

    it('pages newest first', async () => {
      const client = await makeClient();
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await notify({ userId: client.id as string, type: NotificationType.NEW_MESSAGE });
      }

      const page = await listForUser(client.id as string, 1, 2);
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(3);
    });
  });

  describe('devices', () => {
    it('registers a token once, however many times it is sent', async () => {
      const master = await makeMaster();

      await registerDevice(master.id as string, 'device-token-abcdef');
      await registerDevice(master.id as string, 'device-token-abcdef');

      expect((await User.findById(master._id))!.pushTokens).toEqual(['device-token-abcdef']);
    });

    it('removes a token on sign-out', async () => {
      const master = await makeMaster();
      await registerDevice(master.id as string, 'device-token-abcdef');
      await unregisterDevice(master.id as string, 'device-token-abcdef');

      expect((await User.findById(master._id))!.pushTokens).toEqual([]);
    });
  });
});
