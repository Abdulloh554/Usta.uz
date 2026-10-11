import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { issueTokenPair } from '../../src/common/utils/token';
import { Product } from '../../src/modules/product/product.model';
import { Purchase } from '../../src/modules/product/purchase.model';
import { makeClient, makeSeller, makeMaster } from '../helpers/factories';
import { UserRole } from '../../src/common/types';

const app = createApp();
const input = () => ({
  requestId: randomUUID(),
  quantity: 2,
  phone: '+998901234567',
  address: 'Toshkent, Chilonzor 12',
});
const bearer = (id: string, role: UserRole) => `Bearer ${issueTokenPair(id, role).accessToken}`;
async function setup() {
  const buyer = await makeClient();
  const seller = await makeSeller();
  const product = await Product.create({
    seller: seller._id,
    title: 'Hammer drill',
    price: 50000,
    stock: 3,
  });
  return { buyer, seller, product };
}
describe('product purchases', () => {
  it('uses the database price and reserves stock once across concurrent duplicate submits', async () => {
    const { buyer, product } = await setup();
    const body = { ...input(), total: 1, unitPrice: 1 };
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app)
          .post(`/api/v1/products/${product.id}/purchase`)
          .set('Authorization', bearer(buyer.id as string, UserRole.CLIENT))
          .send(body),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(await Purchase.countDocuments()).toBe(1);
    expect(await Purchase.findOne()).toMatchObject({
      total: 100000,
      unitPrice: 50000,
      quantity: 2,
    });
    expect((await Product.findById(product._id))?.stock).toBe(1);
  });

  it('does not oversell when different buyers compete for the remaining stock', async () => {
    const { buyer, product } = await setup();
    const other = await makeMaster();
    const responses = await Promise.all(
      [buyer, other].map((user) =>
        request(app)
          .post(`/api/v1/products/${product.id}/purchase`)
          .set('Authorization', bearer(user.id as string, user.role))
          .send(input()),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await Product.findById(product._id))?.stock).toBe(1);
  });

  it('shows an order only to its buyer and seller, and forbids a buyer accepting it', async () => {
    const { buyer, seller, product } = await setup();
    const placed = await request(app)
      .post(`/api/v1/products/${product.id}/purchase`)
      .set('Authorization', bearer(buyer.id as string, buyer.role))
      .send(input())
      .expect(201);
    const id = placed.body.data.id as string;
    const other = await makeSeller();
    const list = await request(app)
      .get('/api/v1/products/purchases')
      .set('Authorization', bearer(other.id as string, other.role))
      .expect(200);
    expect(list.body.data.total).toBe(0);
    await request(app)
      .patch(`/api/v1/products/purchases/${id}`)
      .set('Authorization', bearer(other.id as string, other.role))
      .send({ status: 'accepted' })
      .expect(403);
    await request(app)
      .patch(`/api/v1/products/purchases/${id}`)
      .set('Authorization', bearer(buyer.id as string, buyer.role))
      .send({ status: 'accepted' })
      .expect(403);
    const own = await request(app)
      .get('/api/v1/products/purchases')
      .set('Authorization', bearer(seller.id as string, seller.role))
      .expect(200);
    expect(own.body.data.total).toBe(1);
  });

  it('restores stock exactly once on cancellation', async () => {
    const { buyer, product } = await setup();
    const placed = await request(app)
      .post(`/api/v1/products/${product.id}/purchase`)
      .set('Authorization', bearer(buyer.id as string, buyer.role))
      .send(input())
      .expect(201);
    const id = placed.body.data.id as string;
    await request(app)
      .patch(`/api/v1/products/purchases/${id}`)
      .set('Authorization', bearer(buyer.id as string, buyer.role))
      .send({ status: 'cancelled' })
      .expect(200);
    await request(app)
      .patch(`/api/v1/products/purchases/${id}`)
      .set('Authorization', bearer(buyer.id as string, buyer.role))
      .send({ status: 'cancelled' })
      .expect(200);
    expect((await Product.findById(product._id))?.stock).toBe(3);
  });

  it('completes accepted orders once and retains the original price after product edits', async () => {
    const { buyer, seller, product } = await setup();
    const placed = await request(app)
      .post(`/api/v1/products/${product.id}/purchase`)
      .set('Authorization', bearer(buyer.id as string, buyer.role))
      .send(input())
      .expect(201);
    const id = placed.body.data.id as string;
    const auth = bearer(seller.id as string, seller.role);
    await request(app)
      .patch(`/api/v1/products/purchases/${id}`)
      .set('Authorization', auth)
      .send({ status: 'completed' })
      .expect(409);
    await Product.updateOne({ _id: product._id }, { price: 70000 });
    await request(app)
      .patch(`/api/v1/products/purchases/${id}`)
      .set('Authorization', auth)
      .send({ status: 'accepted' })
      .expect(200);
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .patch(`/api/v1/products/purchases/${id}`)
        .set('Authorization', auth)
        .send({ status: 'completed' })
        .expect(200);
    }
    expect((await Product.findById(product._id))?.soldCount).toBe(2);
    expect((await Purchase.findById(id))?.total).toBe(100000);
    await request(app)
      .patch(`/api/v1/products/purchases/${id}`)
      .set('Authorization', auth)
      .send({ status: 'cancelled' })
      .expect(409);
  });

  it('validates input and prevents sellers buying through their seller role', async () => {
    const { buyer, seller, product } = await setup();
    await request(app).post(`/api/v1/products/${product.id}/purchase`).send(input()).expect(401);
    await request(app)
      .post(`/api/v1/products/${product.id}/purchase`)
      .set('Authorization', bearer(seller.id as string, seller.role))
      .send(input())
      .expect(403);
    await request(app)
      .post(`/api/v1/products/${product.id}/purchase`)
      .set('Authorization', bearer(buyer.id as string, buyer.role))
      .send({ ...input(), quantity: 0 })
      .expect(422);
    expect((await Product.findById(product._id))?.stock).toBe(3);
  });
});
