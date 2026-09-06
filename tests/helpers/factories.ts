import type mongoose from 'mongoose';
import { User, type UserDocument } from '../../src/modules/user/user.model';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { Order, type OrderDocument } from '../../src/modules/order/order.model';
import { Craft, OrderCategory, OrderStatus, UserRole } from '../../src/common/types';

let sequence = 0;

/** Each call gets a distinct, valid Uzbek number so the unique index never trips. */
export const nextPhone = (): string => {
  sequence += 1;
  return `+99890${String(1_000_000 + sequence).slice(-7)}`;
};

export const makeClient = async (overrides: Partial<{ firstName: string; balance: number }> = {}) =>
  User.create({
    phone: nextPhone(),
    passwordHash: 'secret123',
    firstName: overrides.firstName ?? 'Dilnoza',
    lastName: 'Rahimova',
    role: UserRole.CLIENT,
    acceptedRulesAt: new Date(),
    balance: overrides.balance ?? 0,
  });

export const makeMaster = async (
  overrides: Partial<{
    balance: number;
    rating: number;
    crafts: Craft[];
    isOnline: boolean;
    isAvailable: boolean;
    firstName: string;
    regions: string[];
  }> = {},
): Promise<UserDocument> => {
  const user = await User.create({
    phone: nextPhone(),
    passwordHash: 'secret123',
    firstName: overrides.firstName ?? 'Bekzod',
    lastName: 'Yuldashev',
    role: UserRole.MASTER,
    acceptedRulesAt: new Date(),
    balance: overrides.balance ?? 50_000,
  });

  await MasterProfile.create({
    user: user._id,
    crafts: overrides.crafts ?? [Craft.ELECTRICIAN],
    about: '8 years of experience',
    regions: overrides.regions ?? ['Chilonzor'],
    rating: overrides.rating ?? 4.5,
    ratingCount: 10,
    isOnline: overrides.isOnline ?? true,
    isAvailable: overrides.isAvailable ?? true,
  });

  return user;
};

export const makeSeller = async () =>
  User.create({
    phone: nextPhone(),
    passwordHash: 'secret123',
    firstName: 'Instrument',
    lastName: 'Savdo',
    role: UserRole.SELLER,
    acceptedRulesAt: new Date(),
  });

export const makeOrder = async (
  clientId: mongoose.Types.ObjectId,
  overrides: Partial<{ category: OrderCategory; status: OrderStatus; region: string }> = {},
): Promise<OrderDocument> =>
  Order.create({
    code: `T${String(Date.now()).slice(-5)}${sequence++}`.slice(0, 6).toUpperCase(),
    client: clientId,
    title: 'Laptop will not turn on',
    description: 'No light even with the charger plugged in, Chilonzor district.',
    category: overrides.category ?? OrderCategory.ELECTRICAL,
    status: overrides.status ?? OrderStatus.PENDING,
    region: overrides.region ?? 'Chilonzor',
  });
