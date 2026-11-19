import request from 'supertest';
import { createApp } from '../../src/app';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { makeMaster } from '../helpers/factories';

const app = createApp();

const HIDDEN = [
  'location',
  'isOnline',
  'isAvailable',
  'lastOfferAt',
  'cancelledJobs',
  'user',
  '_id',
];

/** Regression (audit M4): the public pro profile publishes a whitelist only. */
describe('GET /users/masters/:id', () => {
  it('returns only the public profile fields, without location, presence or cancellations', async () => {
    const master = await makeMaster({ rating: 4.8 });
    await MasterProfile.updateOne(
      { user: master._id },
      {
        location: { type: 'Point', coordinates: [69.24, 41.3] },
        lastOfferAt: new Date(),
        cancelledJobs: 3,
        completedJobs: 12,
      },
    );

    const response = await request(app).get(`/api/v1/users/masters/${master.id}`);
    expect(response.status).toBe(200);

    const { profile } = response.body.data;
    expect(Object.keys(profile).sort()).toEqual(
      ['about', 'completedJobs', 'crafts', 'createdAt', 'ratingCount', 'rating', 'regions'].sort(),
    );
    expect(profile.completedJobs).toBe(12);
    expect(profile.rating).toBe(4.8);
    HIDDEN.forEach((field) => expect(profile).not.toHaveProperty(field));
    expect(response.body.data.stats).toEqual({ rating: 4.8, completedJobs: 12, reviewCount: 10 });
  });
});
