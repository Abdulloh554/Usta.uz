import {
  hideReview,
  listForMaster,
  listForProduct,
  rateMaster,
  rateProduct,
} from '../../src/modules/review/review.service';
import { Review } from '../../src/modules/review/review.model';
import { Order } from '../../src/modules/order/order.model';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { Product } from '../../src/modules/product/product.model';
import { createProduct } from '../../src/modules/product/product.service';
import { OrderStatus } from '../../src/common/types';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/common/errors/ApiError';
import { makeClient, makeMaster, makeOrder, makeSeller } from '../helpers/factories';

/** A job that has been accepted, worked and marked complete. */
const finishedJob = async () => {
  const client = await makeClient();
  const master = await makeMaster();
  const order = await makeOrder(client._id);
  await Order.updateOne(
    { _id: order._id },
    { $set: { master: master._id, status: OrderStatus.DONE, completedAt: new Date() } },
  );
  await MasterProfile.updateOne({ user: master._id }, { $set: { rating: 0, ratingCount: 0 } });
  return { client, master, order };
};

describe('review service', () => {
  describe('rateMaster', () => {
    it('records the rating, marks the job rated and recomputes the average', async () => {
      const { client, master, order } = await finishedJob();

      const review = await rateMaster(client.id as string, {
        orderId: order.id as string,
        stars: 5,
        comment: 'Arrived in 30 minutes and worked cleanly.',
      });

      expect(review.stars).toBe(5);
      expect((await Order.findById(order._id))!.isRated).toBe(true);

      const profile = await MasterProfile.findOne({ user: master._id });
      expect(profile!.rating).toBe(5);
      expect(profile!.ratingCount).toBe(1);
    });

    it('averages across several jobs and rounds to one decimal place', async () => {
      const master = await makeMaster();
      await MasterProfile.updateOne({ user: master._id }, { $set: { rating: 0, ratingCount: 0 } });

      for (const stars of [5, 4, 4]) {
        // eslint-disable-next-line no-await-in-loop
        const client = await makeClient();
        // eslint-disable-next-line no-await-in-loop
        const order = await makeOrder(client._id);
        // eslint-disable-next-line no-await-in-loop
        await Order.updateOne(
          { _id: order._id },
          { $set: { master: master._id, status: OrderStatus.DONE } },
        );
        // eslint-disable-next-line no-await-in-loop
        await rateMaster(client.id as string, { orderId: order.id as string, stars });
      }

      const profile = await MasterProfile.findOne({ user: master._id });
      expect(profile!.rating).toBe(4.3);
      expect(profile!.ratingCount).toBe(3);
    });

    it('refuses a job that is not finished', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const order = await makeOrder(client._id);
      await Order.updateOne({ _id: order._id }, { $set: { master: master._id } });

      await expect(
        rateMaster(client.id as string, { orderId: order.id as string, stars: 5 }),
      ).rejects.toThrow(ConflictError);
    });

    it('refuses a second rating on the same job', async () => {
      const { client, order } = await finishedJob();
      await rateMaster(client.id as string, { orderId: order.id as string, stars: 5 });

      await expect(
        rateMaster(client.id as string, { orderId: order.id as string, stars: 1 }),
      ).rejects.toThrow(ConflictError);
    });

    it('refuses anyone but the client who posted the job', async () => {
      const { order } = await finishedJob();
      const stranger = await makeClient();

      await expect(
        rateMaster(stranger.id as string, { orderId: order.id as string, stars: 5 }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('refuses a job that never found a pro', async () => {
      const client = await makeClient();
      const order = await makeOrder(client._id);
      await Order.updateOne({ _id: order._id }, { $set: { status: OrderStatus.DONE } });

      await expect(
        rateMaster(client.id as string, { orderId: order.id as string, stars: 5 }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws for a job that does not exist', async () => {
      const client = await makeClient();
      await expect(
        rateMaster(client.id as string, { orderId: '507f1f77bcf86cd799439011', stars: 5 }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('rateProduct', () => {
    const drill = { title: 'Bosch GBH 2-26', price: 1_890_000 };

    it('records the review and updates the product’s rating', async () => {
      const seller = await makeSeller();
      const buyer = await makeClient();
      const product = await createProduct(seller.id as string, drill);

      await rateProduct(buyer.id as string, {
        productId: product.id as string,
        stars: 4,
        comment: 'Good price and quality, fast delivery.',
      });

      const reloaded = await Product.findById(product._id);
      expect(reloaded!.rating).toBe(4);
      expect(reloaded!.ratingCount).toBe(1);
    });

    it('will not let a seller review their own product', async () => {
      const seller = await makeSeller();
      const product = await createProduct(seller.id as string, drill);

      await expect(
        rateProduct(seller.id as string, { productId: product.id as string, stars: 5 }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('allows one review per person per product', async () => {
      const seller = await makeSeller();
      const buyer = await makeClient();
      const product = await createProduct(seller.id as string, drill);

      await rateProduct(buyer.id as string, { productId: product.id as string, stars: 5 });
      await expect(
        rateProduct(buyer.id as string, { productId: product.id as string, stars: 1 }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws for a product that does not exist', async () => {
      const buyer = await makeClient();
      await expect(
        rateProduct(buyer.id as string, { productId: '507f1f77bcf86cd799439011', stars: 5 }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('hideReview', () => {
    /** The rules screen promises bought ratings are removed — and the average corrects. */
    it('pulls a hidden review out of the average', async () => {
      const master = await makeMaster();
      await MasterProfile.updateOne({ user: master._id }, { $set: { rating: 0, ratingCount: 0 } });

      const ids: string[] = [];
      for (const stars of [5, 1]) {
        // eslint-disable-next-line no-await-in-loop
        const client = await makeClient();
        // eslint-disable-next-line no-await-in-loop
        const order = await makeOrder(client._id);
        // eslint-disable-next-line no-await-in-loop
        await Order.updateOne(
          { _id: order._id },
          { $set: { master: master._id, status: OrderStatus.DONE } },
        );
        // eslint-disable-next-line no-await-in-loop
        const review = await rateMaster(client.id as string, {
          orderId: order.id as string,
          stars,
        });
        ids.push(review.id as string);
      }

      expect((await MasterProfile.findOne({ user: master._id }))!.rating).toBe(3);

      await hideReview(ids[1]!);

      const profile = await MasterProfile.findOne({ user: master._id });
      expect(profile!.rating).toBe(5);
      expect(profile!.ratingCount).toBe(1);
      // The row survives for audit; it is simply no longer visible.
      expect(await Review.countDocuments({})).toBe(2);
    });

    it('throws for a review that does not exist', async () => {
      await expect(hideReview('507f1f77bcf86cd799439011')).rejects.toThrow(NotFoundError);
    });
  });

  describe('listing', () => {
    it('pages a pro’s reviews and hides the invisible ones', async () => {
      const { client, master, order } = await finishedJob();
      const review = await rateMaster(client.id as string, {
        orderId: order.id as string,
        stars: 5,
      });

      expect((await listForMaster(master.id as string, 1, 10)).total).toBe(1);

      await hideReview(review.id as string);
      expect((await listForMaster(master.id as string, 1, 10)).total).toBe(0);
    });

    it('pages a product’s reviews', async () => {
      const seller = await makeSeller();
      const buyer = await makeClient();
      const product = await createProduct(seller.id as string, {
        title: 'Ceresit tile adhesive',
        price: 62_000,
      });
      await rateProduct(buyer.id as string, { productId: product.id as string, stars: 4 });

      const page = await listForProduct(product.id as string, 1, 10);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.stars).toBe(4);
    });
  });
});
