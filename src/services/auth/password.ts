import bcrypt from "bcryptjs";
import { BadRequestError } from "@/utils/errors";

/**
 * Password hashing, shared by signup and by admin-created org members so
 * both paths get identical cost and identical rules.
 */

const BCRYPT_ROUNDS = 12;

/** A dummy hash to compare against when no user row exists, so a failed
 *  login costs the same time whether or not the email is registered. */
export const DUMMY_HASH =
  "$2a$12$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

export function assertValidPassword(password: string): void {
  if (password.length < 8) {
    throw new BadRequestError("Password must be at least 8 characters.");
  }
  if (password.length > 128) {
    throw new BadRequestError("Password must be at most 128 characters.");
  }
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash).catch(() => false);
}
