import bcrypt from 'bcryptjs';

const ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// A valid (but unmatchable) bcrypt hash computed once at startup. The login
// route compares against this when an email is unknown, so the response time
// for "no such account" matches "wrong password" — closing a user-enumeration
// timing oracle.
export const DUMMY_HASH: string = bcrypt.hashSync('minerva:timing-equalizer', ROUNDS);
