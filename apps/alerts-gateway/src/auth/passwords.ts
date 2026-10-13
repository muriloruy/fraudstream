import { randomBytes } from 'node:crypto';
import { hash, verify, type Options } from '@node-rs/argon2';

// argon2id (the library's default algorithm; a test asserts the `$argon2id$` prefix) with the
// OWASP minimums: 19 MiB memory, 2 iterations, 1 lane (SPEC §7 Req. 8).
const OPTIONS: Options = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

/** False for a wrong password and for a malformed hash; never throws. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * A real argon2id hash of a random secret. Unknown emails are verified against it so that
 * they take as long as a wrong password and cannot be told apart by timing.
 */
export const dummyHash = (): Promise<string> =>
  (dummy ??= hashPassword(randomBytes(32).toString('base64url')));
