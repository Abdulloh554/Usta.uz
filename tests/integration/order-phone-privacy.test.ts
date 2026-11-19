import request from 'supertest';
import { createApp } from '../../src/app';
import { OrderStatus, UserRole } from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { Order } from '../../src/modules/order/order.model';
import { makeClient, makeMaster, makeOrder } from '../helpers/factories';

const app = createApp();
const bearer = (id: string, role: UserRole) => `Bearer ${issueTokenPair(id, role).accessToken}`;

/**
 * Regression (audit K2): the client's phone number is what the accept fee buys.
 * A pro who was only *offered* the job must not read it from GET /orders/:id.
 */
describe('client phone on a job a pro has not accepted', () => {
  it('is hidden from an offered pro, and revealed once they are the assigned master', async () => {
    const client = await makeClient();
    const master = await makeMaster();
    const order = await makeOrder(client._id, { status: OrderStatus.MATCHING });
    await Order.updateOne({ _id: order._id }, { $push: { offers: { master: master._id } } });

    const masterAuth = bearer(master.id as string, UserRole.MASTER);

    const offered = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', masterAuth);
    expect(offered.status).toBe(200);
    expect(offered.body.data.client.firstName).toBe('Dilnoza');
    expect(offered.body.data.client.phone).toBeUndefined();
    expect(JSON.stringify(offered.body)).not.toContain(client.phone);

    await Order.updateOne({ _id: order._id }, { master: master._id, status: OrderStatus.ACCEPTED });

    const accepted = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', masterAuth);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.client.phone).toBe(client.phone);
  });

  it('is still shown to the client who owns the job', async () => {
    const client = await makeClient();
    const order = await makeOrder(client._id);

    const response = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', bearer(client.id as string, UserRole.CLIENT));
    expect(response.status).toBe(200);
    expect(response.body.data.client.phone).toBe(client.phone);
  });

  it('is hidden from an offered pro after someone else accepted the job', async () => {
    const client = await makeClient();
    const winner = await makeMaster();
    const other = await makeMaster();
    const order = await makeOrder(client._id, { status: OrderStatus.MATCHING });
    await Order.updateOne(
      { _id: order._id },
      {
        $push: { offers: { $each: [{ master: other._id }, { master: winner._id }] } },
        master: winner._id,
        status: OrderStatus.ACCEPTED,
      },
    );

    const response = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', bearer(other.id as string, UserRole.MASTER));
    expect(response.status).toBe(200);
    expect(response.body.data.client.phone).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(client.phone);
  });
});
