import {
  confirmTopUp,
  failTopUp,
  getBalance,
  listTransactions,
  refundOrderFee,
  startTopUp,
  verifyClickSignature,
} from '../../src/modules/wallet/wallet.service';
import { Transaction } from '../../src/modules/wallet/transaction.model';
import { User } from '../../src/modules/user/user.model';
import {
  PaymentProvider,
  TransactionStatus,
  TransactionType,
} from '../../src/common/types';
import { BadRequestError, ConflictError, NotFoundError } from '../../src/common/errors/ApiError';
import { makeClient, makeMaster, makeOrder } from '../helpers/factories';

describe('wallet service', () => {
  describe('getBalance', () => {
    it('returns the balance alongside the current job fee', async () => {
      const master = await makeMaster({ balance: 25_000 });
      expect(await getBalance(master.id as string)).toEqual({ balance: 25_000, fee: 4999 });
    });

    it('throws for a user who does not exist', async () => {
      await expect(getBalance('507f1f77bcf86cd799439011')).rejects.toThrow(NotFoundError);
    });
  });

  describe('startTopUp', () => {
    it('records a pending transaction without moving the balance', async () => {
      const master = await makeMaster({ balance: 1_000 });

      const result = await startTopUp(master.id as string, {
        amount: 50_000,
        provider: PaymentProvider.CLICK,
      });

      expect(result.amount).toBe(50_000);
      expect(result.checkoutUrl).toContain('click');

      const transaction = await Transaction.findById(result.transactionId);
      expect(transaction!.status).toBe(TransactionStatus.PENDING);
      // Nothing has been paid yet, so the wallet is untouched.
      expect((await User.findById(master._id))!.balance).toBe(1_000);
    });

    it('builds a base64 Payme checkout link with the amount in tiyin', async () => {
      const master = await makeMaster();
      const result = await startTopUp(master.id as string, {
        amount: 10_000,
        provider: PaymentProvider.PAYME,
      });

      const encoded = result.checkoutUrl.split('/').pop() ?? '';
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      expect(decoded).toContain('a=1000000');
      expect(decoded).toContain(`ac.transaction_id=${result.transactionId}`);
    });

    it('refuses an amount below the minimum', async () => {
      const master = await makeMaster();
      await expect(
        startTopUp(master.id as string, { amount: 500, provider: PaymentProvider.CLICK }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('confirmTopUp', () => {
    it('credits the wallet and records the settlement', async () => {
      const master = await makeMaster({ balance: 1_000 });
      const { transactionId } = await startTopUp(master.id as string, {
        amount: 20_000,
        provider: PaymentProvider.CLICK,
      });

      const settled = await confirmTopUp(transactionId, 'click-123');

      expect(settled.status).toBe(TransactionStatus.SUCCESS);
      expect(settled.balanceAfter).toBe(21_000);
      expect(settled.externalId).toBe('click-123');
      expect((await User.findById(master._id))!.balance).toBe(21_000);
    });

    /** Providers retry their callbacks; a replay must not credit twice. */
    it('is idempotent when the provider retries the callback', async () => {
      const master = await makeMaster({ balance: 0 });
      const { transactionId } = await startTopUp(master.id as string, {
        amount: 20_000,
        provider: PaymentProvider.CLICK,
      });

      await confirmTopUp(transactionId, 'click-123');
      await confirmTopUp(transactionId, 'click-123');
      await confirmTopUp(transactionId, 'click-123');

      expect((await User.findById(master._id))!.balance).toBe(20_000);
    });

    it('will not settle a transaction that already failed', async () => {
      const master = await makeMaster();
      const { transactionId } = await startTopUp(master.id as string, {
        amount: 20_000,
        provider: PaymentProvider.CLICK,
      });
      await failTopUp(transactionId, 'cancelled by user');

      await expect(confirmTopUp(transactionId, 'click-123')).rejects.toThrow(ConflictError);
    });

    it('throws for an unknown transaction', async () => {
      await expect(confirmTopUp('507f1f77bcf86cd799439011', 'x')).rejects.toThrow(NotFoundError);
    });
  });

  describe('verifyClickSignature', () => {
    const base = {
      clickTransId: '111',
      serviceId: '222',
      merchantTransId: 'abc',
      amount: '5000',
      action: '1',
      signTime: '2026-01-01 00:00:00',
    };

    it('accepts a correctly signed callback', async () => {
      const crypto = await import('node:crypto');
      const { env } = await import('../../src/config/env');
      const signString = crypto
        .createHash('md5')
        .update(
          [
            base.clickTransId,
            base.serviceId,
            env.CLICK_SECRET_KEY,
            base.merchantTransId,
            base.amount,
            base.action,
            base.signTime,
          ].join(''),
        )
        .digest('hex');

      expect(verifyClickSignature({ ...base, signString })).toBe(true);
    });

    it('rejects a forged signature', () => {
      expect(verifyClickSignature({ ...base, signString: 'a'.repeat(32) })).toBe(false);
    });

    it('rejects a signature of the wrong length without throwing', () => {
      expect(verifyClickSignature({ ...base, signString: 'short' })).toBe(false);
    });
  });

  describe('refundOrderFee', () => {
    it('returns the fee and credits the pro exactly once', async () => {
      const client = await makeClient();
      const master = await makeMaster({ balance: 10_000 });
      const order = await makeOrder(client._id);

      await Transaction.create({
        user: master._id,
        type: TransactionType.ORDER_FEE,
        status: TransactionStatus.SUCCESS,
        provider: PaymentProvider.BALANCE,
        amount: -4999,
        order: order._id,
        description: 'fee',
        settledAt: new Date(),
      });

      const refund = await refundOrderFee(order.id as string);
      expect(refund!.amount).toBe(4999);
      expect((await User.findById(master._id))!.balance).toBe(14_999);

      // A second attempt is a no-op.
      expect(await refundOrderFee(order.id as string)).toBeNull();
      expect((await User.findById(master._id))!.balance).toBe(14_999);
    });

    it('returns null when there was no fee to refund', async () => {
      const client = await makeClient();
      const order = await makeOrder(client._id);
      expect(await refundOrderFee(order.id as string)).toBeNull();
    });
  });

  describe('listTransactions', () => {
    it('pages newest first', async () => {
      const master = await makeMaster();
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await startTopUp(master.id as string, {
          amount: 10_000 + i,
          provider: PaymentProvider.CLICK,
        });
      }

      const page = await listTransactions(master.id as string, 1, 2);
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(3);
      expect(page.pages).toBe(2);
    });
  });
});
