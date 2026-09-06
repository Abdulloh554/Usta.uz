import {
  findById,
  getMasterProfile,
  setOnline,
  topMasters,
  updateMasterProfile,
  updateProfile,
  workHistory,
} from '../../src/modules/user/user.service';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { Order } from '../../src/modules/order/order.model';
import { Craft, Language, OrderStatus } from '../../src/common/types';
import { NotFoundError } from '../../src/common/errors/ApiError';
import { makeClient, makeMaster, makeOrder } from '../helpers/factories';

describe('user service', () => {
  describe('updateProfile', () => {
    it('updates the name and language, and keeps the hash out of the result', async () => {
      const client = await makeClient();

      const updated = await updateProfile(client.id as string, {
        firstName: 'Aziza',
        language: Language.RU,
      });

      expect(updated.firstName).toBe('Aziza');
      expect(updated.language).toBe(Language.RU);
      expect(updated.initials).toBe('AR');
      expect(JSON.stringify(updated)).not.toContain('passwordHash');
    });

    it('throws for a user who does not exist', async () => {
      await expect(
        updateProfile('507f1f77bcf86cd799439011', { firstName: 'Nobody' }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateMasterProfile', () => {
    it('replaces the trades and stores the location as GeoJSON', async () => {
      const master = await makeMaster();

      const updated = await updateMasterProfile(master.id as string, {
        crafts: [Craft.TILER, Craft.PAINTER],
        about: 'Bathroom and kitchen finishing',
        location: [69.24, 41.31],
      });

      expect(updated.crafts).toEqual([Craft.TILER, Craft.PAINTER]);
      expect(updated.about).toBe('Bathroom and kitchen finishing');
      expect(updated.location).toEqual({ type: 'Point', coordinates: [69.24, 41.31] });
    });

    it('can take a pro out of the running without taking them offline', async () => {
      const master = await makeMaster();
      const updated = await updateMasterProfile(master.id as string, { isAvailable: false });

      expect(updated.isAvailable).toBe(false);
      expect(updated.isOnline).toBe(true);
    });

    it('throws when there is no trade profile', async () => {
      const client = await makeClient();
      await expect(
        updateMasterProfile(client.id as string, { about: 'x' }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('setOnline', () => {
    it('mirrors online state onto the profile the matching query reads', async () => {
      const master = await makeMaster({ isOnline: false });

      await setOnline(master.id as string, true);
      expect((await MasterProfile.findOne({ user: master._id }))!.isOnline).toBe(true);

      await setOnline(master.id as string, false);
      expect((await MasterProfile.findOne({ user: master._id }))!.isOnline).toBe(false);
    });
  });

  describe('getMasterProfile', () => {
    it('returns the account, profile and headline stats together', async () => {
      const master = await makeMaster({ rating: 4.9 });

      const result = await getMasterProfile(master.id as string);

      expect(result.user.id).toBe(master.id);
      expect(result.stats.rating).toBe(4.9);
      expect(result.stats.reviewCount).toBe(10);
    });

    it('refuses to treat a client as a pro', async () => {
      const client = await makeClient();
      await expect(getMasterProfile(client.id as string)).rejects.toThrow(NotFoundError);
    });
  });

  describe('topMasters', () => {
    it('ranks by rating and respects the limit', async () => {
      await makeMaster({ rating: 4.1, firstName: 'Middle' });
      await makeMaster({ rating: 4.9, firstName: 'Best' });
      await makeMaster({ rating: 3.2, firstName: 'Lowest' });

      const top = await topMasters(2);

      expect(top).toHaveLength(2);
      expect(top[0]!.name).toContain('Best');
      expect(top[0]!.initials).toBe('BY');
      expect(top[1]!.name).toContain('Middle');
    });

    it('filters by trade', async () => {
      await makeMaster({ crafts: [Craft.PLUMBER], firstName: 'Plumber' });
      await makeMaster({ crafts: [Craft.TILER], firstName: 'Tiler' });

      const top = await topMasters(10, Craft.TILER);

      expect(top).toHaveLength(1);
      expect(top[0]!.name).toContain('Tiler');
    });

    it('leaves out a pro nobody has rated yet', async () => {
      const master = await makeMaster();
      await MasterProfile.updateOne({ user: master._id }, { $set: { ratingCount: 0 } });

      expect(await topMasters(10)).toHaveLength(0);
    });
  });

  describe('workHistory', () => {
    it('returns only completed jobs, most recent first', async () => {
      const client = await makeClient();
      const master = await makeMaster();

      const done = await makeOrder(client._id, { status: OrderStatus.DONE });
      await Order.updateOne(
        { _id: done._id },
        { $set: { master: master._id, completedAt: new Date() } },
      );

      // A cancelled job needs its reason, which the model enforces on save.
      const cancelled = await makeOrder(client._id);
      await Order.updateOne(
        { _id: cancelled._id },
        {
          $set: {
            master: master._id,
            status: OrderStatus.CANCELLED,
            cancelReason: 'Postponed for now',
          },
        },
      );

      const history = await workHistory(master.id as string);

      expect(history).toHaveLength(1);
      expect(history[0]!.code).toBe(done.code);
    });
  });

  it('finds a user by id and throws when there is none', async () => {
    const client = await makeClient();
    expect((await findById(client.id as string)).id).toBe(client.id);
    await expect(findById('507f1f77bcf86cd799439011')).rejects.toThrow(NotFoundError);
  });
});
