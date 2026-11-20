/* eslint-disable no-console */
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/database';
import { normalizePhone, isValidUzPhone } from '../src/common/utils/phone';
import { normalizeEmail } from '../src/common/utils/email';
import { UserRole } from '../src/common/types';
import { User } from '../src/modules/user/user.model';

/**
 * Creates the first admin account, or promotes an existing one.
 *
 *   npm run admin:create -- admin@example.com "S3cret-pass" Ism Familiya +998901234567
 *
 * The admin signs in with the email. The phone is only needed when the account
 * is created (or to attach an email to an older, phone-only account). Sign-up
 * deliberately refuses the admin role, so this is the only way in. An existing
 * account with the email (or phone) is promoted and its password replaced.
 */
const main = async (): Promise<void> => {
  const [emailArg, password, firstName = 'Admin', lastName = 'Usta', phoneArg] = process.argv.slice(2);

  if (!emailArg || !password) {
    console.error(
      'Usage: npm run admin:create -- <email> <password> [firstName] [lastName] [phone]',
    );
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg)) {
    console.error(`"${emailArg}" is not a valid email address.`);
    process.exit(1);
  }
  if (phoneArg && !isValidUzPhone(phoneArg)) {
    console.error(`"${phoneArg}" is not a valid Uzbek mobile number.`);
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('An admin password must be at least 8 characters.');
    process.exit(1);
  }

  await connectDatabase();
  const email = normalizeEmail(emailArg);
  const phone = phoneArg ? normalizePhone(phoneArg) : undefined;

  const existing =
    (await User.findOne({ email }).select('+passwordHash')) ??
    (phone ? await User.findOne({ phone }).select('+passwordHash') : null);

  if (existing) {
    existing.role = UserRole.ADMIN;
    existing.email = email;
    existing.passwordHash = password;
    existing.isBlocked = false;
    existing.isActive = true;
    await existing.save();
    console.log(`Promoted ${existing.fullName()} (${email}) to admin.`);
  } else {
    if (!phone) {
      console.error('A new admin needs a phone number as the last argument.');
      await mongoose.disconnect();
      process.exit(1);
    }
    const user = await User.create({
      phone,
      email,
      passwordHash: password,
      firstName,
      lastName,
      role: UserRole.ADMIN,
      acceptedRulesAt: new Date(),
      isPhoneVerified: true,
    });
    console.log(`Created admin ${user.fullName()} (${email}).`);
  }

  await mongoose.disconnect();
};

void main().catch(async (error: unknown) => {
  console.error('Could not create the admin:', error);
  await mongoose.disconnect();
  process.exit(1);
});
