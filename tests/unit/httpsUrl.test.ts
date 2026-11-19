import { httpsUrl } from '../../src/common/utils/url';
import { createOrderSchema } from '../../src/modules/order/order.validator';
import { sendMessageSchema } from '../../src/modules/chat/chat.validator';
import { MessageKind } from '../../src/modules/chat/chat.model';
import { OrderCategory } from '../../src/common/types';

const REJECTED = [
  'javascript:alert(1)', // eslint-disable-line no-script-url
  'JAVASCRIPT:alert(1)', // eslint-disable-line no-script-url
  'http://example.com/a.jpg',
  'data:image/png;base64,AAAA',
  'ftp://example.com/a.jpg',
  'not a url',
];
const GOOD = 'https://res.cloudinary.com/demo/image/upload/a.jpg';

describe('https-only URL validation', () => {
  const schema = httpsUrl();

  it('accepts an https link', () => {
    expect(schema.safeParse(GOOD).success).toBe(true);
  });

  it.each(REJECTED)('rejects %s', (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  const order = {
    title: 'Suv oqyapti',
    description: 'Oshxonadagi quvurdan suv oqyapti.',
    category: OrderCategory.PLUMBING,
  };

  it.each(REJECTED)('rejects order photo %s', (value) => {
    expect(createOrderSchema.safeParse({ ...order, photos: [value] }).success).toBe(false);
  });

  it('accepts an https order photo', () => {
    expect(createOrderSchema.safeParse({ ...order, photos: [GOOD] }).success).toBe(true);
  });

  it.each(REJECTED)('rejects chat attachment %s', (value) => {
    expect(
      sendMessageSchema.safeParse({ kind: MessageKind.IMAGE, attachmentUrl: value }).success,
    ).toBe(false);
  });

  it('accepts an https chat attachment', () => {
    expect(
      sendMessageSchema.safeParse({ kind: MessageKind.IMAGE, attachmentUrl: GOOD }).success,
    ).toBe(true);
  });
});
