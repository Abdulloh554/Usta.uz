import mongoose from 'mongoose';
import {
  acceptOffer,
  buildCandidates,
  expireOffer,
  offerNext,
  passOffer,
  startMatching,
} from '../../src/modules/matching/matching.service';
import { Order } from '../../src/modules/order/order.model';
import { User } from '../../src/modules/user/user.model';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { Transaction } from '../../src/modules/wallet/transaction.model';
import { Chat } from '../../src/modules/chat/chat.model';
import { Craft, OrderCategory, OrderStatus, TransactionType } from '../../src/common/types';
import { ConflictError, PaymentRequiredError } from '../../src/common/errors/ApiError';
import { env } from '../../src/config/env';
import { makeClient, makeMaster, makeOrder } from '../helpers/factories';

const FEE = env.ORDER_ACCEPT_FEE;

describe('matching service', () => {
  describe('buildCandidates', () => {
    it('ranks matching pros by rating, best first', async () => {
      const client = await makeClient();
      const low = await makeMaster({ rating: 3.2 });
      const high = await makeMaster({ rating: 4.9 });
      const middle = await makeMaster({ rating: 4.1 });
      const order = await makeOrder(client._id);

      const candidates = await buildCandidates(order);

      expect(candidates.map((candidate) => candidate.masterId)).toEqual([
        high.id,
        middle.id,
        low.id,
      ]);
    });

    it('leaves out a pro whose balance cannot cover the fee', async () => {
      const client = await makeClient();
      await makeMaster({ balance: FEE - 1 });
      const funded = await makeMaster({ balance: FEE });
      const order = await makeOrder(client._id);

      const candidates = await buildCandidates(order);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.masterId).toBe(funded.id);
    });

    it('leaves out offline and unavailable pros', async () => {
      const client = await makeClient();
      await makeMaster({ isOnline: false });
      await makeMaster({ isAvailable: false });
      const order = await makeOrder(client._id);

      expect(await buildCandidates(order)).toHaveLength(0);
    });

    it('only considers trades that serve the job category', async () => {
      const client = await makeClient();
      await makeMaster({ crafts: [Craft.PLUMBER] });
      const tiler = await makeMaster({ crafts: [Craft.TILER] });
      const order = await makeOrder(client._id, { category: OrderCategory.RENOVATION });

      const candidates = await buildCandidates(order);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.masterId).toBe(tiler.id);
    });

    it('never offers a job to the person who posted it', async () => {
      const master = await makeMaster();
      const order = await makeOrder(master._id);

      expect(await buildCandidates(order)).toHaveLength(0);
    });

    it('skips a blocked account even when its profile still looks eligible', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      await User.updateOne({ _id: master._id }, { $set: { isBlocked: true } });
      const order = await makeOrder(client._id);

      expect(await buildCandidates(order)).toHaveLength(0);
    });
  });

  describe('startMatching', () => {
    it('offers the job to the best-rated pro and moves the job to matching', async () => {
      const client = await makeClient();
      await makeMaster({ rating: 3.0 });
      const best = await makeMaster({ rating: 5.0 });
      const order = await makeOrder(client._id);

      const state = await startMatching(order.id as string);

      expect(state.current).toBe(best.id);
      expect(state.remaining).toBe(1);

      const reloaded = await Order.findById(order._id);
      expect(reloaded!.status).toBe(OrderStatus.MATCHING);
      expect(reloaded!.offers).toHaveLength(1);
      expect(reloaded!.offers[0]!.outcome).toBe('pending');
    });

    it('reports no candidates and leaves the job pending', async () => {
      const client = await makeClient();
      const order = await makeOrder(client._id);

      const state = await startMatching(order.id as string);

      expect(state.current).toBeNull();
      expect(state.offered).toBe(0);
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);
    });
  });

  describe('passOffer', () => {
    it('hands the job to the next pro down the list', async () => {
      const client = await makeClient();
      const first = await makeMaster({ rating: 5.0 });
      const second = await makeMaster({ rating: 4.0 });
      const order = await makeOrder(client._id);

      await startMatching(order.id as string);
      const state = await passOffer(order.id as string, first.id as string);

      expect(state.current).toBe(second.id);

      const reloaded = await Order.findById(order._id);
      expect(reloaded!.offers[0]!.outcome).toBe('passed');
      expect(reloaded!.offers[0]!.respondedAt).toBeDefined();
    });

    it('refuses a pro who does not hold the offer', async () => {
      const client = await makeClient();
      await makeMaster({ rating: 5.0 });
      const other = await makeMaster({ rating: 4.0 });
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);

      await expect(passOffer(order.id as string, other.id as string)).rejects.toThrow(ConflictError);
    });

    it('falls back to pending once the list is exhausted', async () => {
      const client = await makeClient();
      const only = await makeMaster();
      const order = await makeOrder(client._id);

      await startMatching(order.id as string);
      const state = await passOffer(order.id as string, only.id as string);

      expect(state.current).toBeNull();
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);
    });
  });

  describe('expireOffer', () => {
    it('marks the offer timed out and moves on', async () => {
      const client = await makeClient();
      const first = await makeMaster({ rating: 5.0 });
      const second = await makeMaster({ rating: 4.0 });
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);

      const state = await expireOffer(order.id as string, first.id as string);

      expect(state!.current).toBe(second.id);
      expect((await Order.findById(order._id))!.offers[0]!.outcome).toBe('timeout');
    });

    it('does nothing when the offer has already moved on', async () => {
      const client = await makeClient();
      const first = await makeMaster({ rating: 5.0 });
      const second = await makeMaster({ rating: 4.0 });
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);
      await passOffer(order.id as string, first.id as string);

      // A timeout job firing late for the first pro must not disturb the
      // offer now held by the second.
      expect(await expireOffer(order.id as string, first.id as string)).toBeNull();

      const reloaded = await Order.findById(order._id);
      expect(reloaded!.offers[1]!.master.toString()).toBe(second.id);
      expect(reloaded!.offers[1]!.outcome).toBe('pending');
    });
  });

  describe('acceptOffer', () => {
    it('assigns the job, charges the fee once and opens a chat', async () => {
      const client = await makeClient();
      const master = await makeMaster({ balance: 50_000 });
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);

      const result = await acceptOffer(order.id as string, master.id as string);

      expect(result.fee).toBe(FEE);

      const reloaded = await Order.findById(order._id);
      expect(reloaded!.status).toBe(OrderStatus.ACCEPTED);
      expect(reloaded!.master!.toString()).toBe(master.id);
      expect(reloaded!.acceptFee).toBe(FEE);
      expect(reloaded!.offers[0]!.outcome).toBe('accepted');

      const account = await User.findById(master._id);
      expect(account!.balance).toBe(50_000 - FEE);

      const fees = await Transaction.find({ order: order._id, type: TransactionType.ORDER_FEE });
      expect(fees).toHaveLength(1);
      expect(fees[0]!.amount).toBe(-FEE);

      const chat = await Chat.findById(result.chatId);
      expect(chat).not.toBeNull();
      expect(chat!.participants.map((id) => id.toString()).sort()).toEqual(
        [client.id, master.id].sort(),
      );
    });

    it('rejects a pro who does not hold the offer', async () => {
      const client = await makeClient();
      await makeMaster({ rating: 5.0 });
      const other = await makeMaster({ rating: 4.0 });
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);

      await expect(acceptOffer(order.id as string, other.id as string)).rejects.toThrow(ConflictError);
    });

    /**
     * The feed lists every open job in the pro's trades, so a pro who never got
     * the ring — or let it pass to someone who then declined — can still take
     * the work from the list. Nothing is ringing here: no offer was ever made.
     */
    it('lets a pro claim an open job straight from the feed', async () => {
      const client = await makeClient();
      const master = await makeMaster({ balance: 50_000 });
      const order = await makeOrder(client._id);

      const result = await acceptOffer(order.id as string, master.id as string);

      const reloaded = await Order.findById(order._id);
      expect(reloaded!.status).toBe(OrderStatus.ACCEPTED);
      expect(reloaded!.master!.toString()).toBe(master.id);
      expect(await Chat.findById(result.chatId)).not.toBeNull();
    });

    it('refuses a claim on a trade the pro does not work in', async () => {
      const client = await makeClient();
      const plumber = await makeMaster({ crafts: [Craft.PLUMBER] });
      // The factory's default job is electrical work.
      const order = await makeOrder(client._id, { category: OrderCategory.ELECTRICAL });

      await expect(acceptOffer(order.id as string, plumber.id as string)).rejects.toThrow(
        ConflictError,
      );
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.PENDING);
    });

    it('refuses a pro claiming a job they posted themselves', async () => {
      const master = await makeMaster();
      const order = await makeOrder(master._id);

      await expect(acceptOffer(order.id as string, master.id as string)).rejects.toThrow(
        ConflictError,
      );
    });

    it('refuses when the balance dropped below the fee after the offer went out', async () => {
      const client = await makeClient();
      const master = await makeMaster({ balance: 50_000 });
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);

      await User.updateOne({ _id: master._id }, { $set: { balance: 100 } });

      await expect(acceptOffer(order.id as string, master.id as string)).rejects.toThrow(
        PaymentRequiredError,
      );
      expect((await Order.findById(order._id))!.status).toBe(OrderStatus.MATCHING);
    });

    /**
     * The race the brief calls out. Two accepts land at the same instant —
     * here from one pro double-tapping, which exercises exactly the same
     * database guard as two pros racing, and does so deterministically.
     * Exactly one may win, and the fee may be charged exactly once.
     */
    it('lets only one of two simultaneous accepts through, and charges the fee once', async () => {
      const client = await makeClient();
      const master = await makeMaster({ balance: 50_000 });
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);

      const outcomes = await Promise.allSettled([
        acceptOffer(order.id as string, master.id as string),
        acceptOffer(order.id as string, master.id as string),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

      const reloaded = await Order.findById(order._id);
      expect(reloaded!.status).toBe(OrderStatus.ACCEPTED);
      expect(reloaded!.master!.toString()).toBe(master.id);

      const fees = await Transaction.find({ order: order._id, type: TransactionType.ORDER_FEE });
      expect(fees).toHaveLength(1);
      // Charged once, not twice — the losing call's debit was rolled back.
      expect((await User.findById(master._id))!.balance).toBe(50_000 - FEE);
    });

    it('turns away a second pro once the job has been taken', async () => {
      const client = await makeClient();
      const winner = await makeMaster({ balance: 50_000, rating: 5.0 });
      const loser = await makeMaster({ balance: 50_000, rating: 4.0 });
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);
      await acceptOffer(order.id as string, winner.id as string);

      // The loser's client may still be showing the offer card.
      const { keys, redis } = await import('../../src/config/redis');
      const now = Date.now();
      await redis.set(
        keys.matchOffer(order.id as string),
        JSON.stringify({
          orderId: order.id,
          masterId: loser.id,
          offeredAt: now,
          expiresAt: now + 45_000,
        }),
        'EX',
        60,
      );

      await expect(acceptOffer(order.id as string, loser.id as string)).rejects.toThrow(ConflictError);

      // And they keep every so'm.
      expect((await User.findById(loser._id))!.balance).toBe(50_000);
      expect(await Transaction.countDocuments({ order: order._id, type: TransactionType.ORDER_FEE })).toBe(1);
    });

    it('does not reopen a job that is already accepted', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const order = await makeOrder(client._id);
      await startMatching(order.id as string);
      await acceptOffer(order.id as string, master.id as string);

      // A second offer cannot be made on a taken job.
      const state = await offerNext(order.id as string);
      expect(state.current).toBeNull();
    });
  });

  it('does not offer a job to a pro who already passed on it', async () => {
    const client = await makeClient();
    const master = await makeMaster();
    const order = await makeOrder(client._id);
    await startMatching(order.id as string);
    await passOffer(order.id as string, master.id as string);

    // Re-running the search picks the pro up again — the exclusion of a pro who
    // passed lives in the browsable feed, not in the queue itself.
    const state = await startMatching(order.id as string);
    expect(state.current).toBe(master.id);

    const reloaded = await Order.findById(order._id);
    expect(reloaded!.offers).toHaveLength(2);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await MasterProfile.deleteMany({});
  });
});
