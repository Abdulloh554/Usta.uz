/* eslint-disable no-console */
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/database';
import { normalizePhone, isValidUzPhone } from '../src/common/utils/phone';
import { UserRole } from '../src/common/types';
import { User } from '../src/modules/user/user.model';

/**
 * Creates the first admin account, or promotes an existing one.
 *
 *   npm run admin:create -- +998901234567 "S3cret-pass" Ism Familiya
 *
 * Sign-up deliberately refuses the admin role, so this is the only way in. An
 * existing account with the number is promoted and its password replaced.
 */
const main = async (): Promise<void> => {
  const [phoneArg, password, firstName = 'Admin', lastName = 'Usta'] = process.argv.slice(2);

  if (!phoneArg || !password) {
    console.error('Usage: npm run admin:create -- <phone> <password> [firstName] [lastName]');
    process.exit(1);
  }
  if (!isValidUzPhone(phoneArg)) {
    console.error(`"${phoneArg}" is not a valid Uzbek mobile number.`);
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('An admin password must be at least 8 characters.');
    process.exit(1);
  }

  await connectDatabase();
  const phone = normalizePhone(phoneArg);

  const existing = await User.findOne({ phone }).select('+passwordHash');
  if (existing) {
    existing.role = UserRole.ADMIN;
    existing.passwordHash = password;
    existing.isBlocked = false;
    existing.isActive = true;
    await existing.save();
    console.log(`Promoted ${existing.fullName()} (${phone}) to admin.`);
  } else {
    const user = await User.create({
      phone,
      passwordHash: password,
      firstName,
      lastName,
      role: UserRole.ADMIN,
      acceptedRulesAt: new Date(),
      isPhoneVerified: true,
    });
    console.log(`Created admin ${user.fullName()} (${phone}).`);
  }

  await mongoose.disconnect();
};

void main().catch(async (error: unknown) => {
  console.error('Could not create the admin:', error);
  await mongoose.disconnect();
  process.exit(1);
});
