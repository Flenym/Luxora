import { randomBytes } from "node:crypto";

import * as argon2 from "argon2";

export const PASSWORD_ARGON2_OPTIONS: argon2.Options & { raw?: false } = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32
});

export const PASSKEY_DISABLED_PASSWORD_HASH_PATTERN =
  /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/u;

export async function hashPassword(value: string | Buffer): Promise<string> {
  return argon2.hash(value, PASSWORD_ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, candidate: string): Promise<boolean> {
  return argon2.verify(hash, candidate);
}

/** The random secret is zeroed and discarded; only its per-account Argon2id hash survives. */
export async function createPasskeyDisabledPasswordHash(): Promise<string> {
  const discardedSecret = randomBytes(32);
  try {
    return await hashPassword(discardedSecret);
  } finally {
    discardedSecret.fill(0);
  }
}
