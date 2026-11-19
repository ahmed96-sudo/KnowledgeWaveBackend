import { prisma } from "./prisma.js";

/**
 * Deletes expired sessions, idempotency keys and password-reset tokens. Cleanup only: every lookup already ignores
 * expired rows, so nothing works late just because this has not run yet. Safe with several instances.
 */
export async function purgeExpired(now = new Date()) {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } });
}
