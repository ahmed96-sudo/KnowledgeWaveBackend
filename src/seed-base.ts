import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "./auth/password.js";
import { prisma } from "./lib/prisma.js";

type Db = typeof prisma;

export const BaseSeedEnvSchema = z.object({
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12, "ADMIN_PASSWORD must be at least 12 characters"),
  ADMIN_NAME: z.string().min(2).default("Admin"),
});

/**
 * The only data a fresh (production) server needs: the first admin account. Everything else (categories, courses,
 * coupons...) is created from the admin screens. Create-only: if the email already exists nothing is changed, so
 * re-running it can never reset a live admin's password.
 */
export async function seedBase(input: z.infer<typeof BaseSeedEnvSchema>, db: Db = prisma) {
  const email = input.ADMIN_EMAIL.trim().toLowerCase();
  if (await db.user.findUnique({ where: { email } })) return { created: false as const };
  const passwordHash = await hashPassword(input.ADMIN_PASSWORD);
  await db.user.create({
    data: { id: `u-${randomUUID()}`, name: input.ADMIN_NAME.trim(), email, passwordHash, role: "admin", settings: { create: {} } },
  });
  return { created: true as const };
}
