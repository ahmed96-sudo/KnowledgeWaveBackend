import argon2 from "argon2";

export const hashPassword = (plain: string) => argon2.hash(plain, { type: argon2.argon2id });

export const verifyPassword = (hash: string, plain: string) => argon2.verify(hash, plain).catch(() => false);

let dummyHash: Promise<string> | undefined;

/** Verify against a throwaway hash so an unknown email takes as long as a wrong password (no timing leak). */
export async function burnPasswordCheck(plain: string) {
  dummyHash ??= hashPassword("not-a-real-password");
  await verifyPassword(await dummyHash, plain);
}
