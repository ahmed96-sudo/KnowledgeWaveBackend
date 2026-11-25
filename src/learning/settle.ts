import type { Tx } from "../lib/prisma.js";
import { BADGES, activeDays, bestStreak, levelFromXp, type Snapshot } from "./gamification.js";
import { notify, texts } from "./notify.js";

/** What an action changed, for the UI's toasts (BACKEND_SPEC §6.2). */
export type Effects = { xpGained: number; levelUp?: number; newBadges: string[]; certificateId?: string; courseCompleted?: string };

/** The context of one learner action: it runs inside a transaction holding that learner's lock. */
export type Ctx = { tx: Tx; userId: string; now: Date; /** strictly increasing timestamps, so rows made in one action keep their order */ tick: () => Date };

export async function xpTotal(tx: Tx, userId: string) {
  return (await tx.xpEvent.aggregate({ where: { userId }, _sum: { amount: true } }))._sum.amount ?? 0;
}

/**
 * After every action that can change XP or progress: award newly earned badges (once each, the primary key
 * guarantees it), notify badges and level-ups, and report what changed.
 */
export async function settle(ctx: Ctx, xpBefore: number): Promise<Effects> {
  const { tx, userId } = ctx;
  const where = { userId };
  const [xpAfter, lessonsDone, certificates, enrollments, reviews, perfect, awarded, activity, xpDates] = await Promise.all([
    xpTotal(tx, userId),
    tx.lessonProgress.count({ where: { ...where, completed: true } }),
    tx.certificate.count({ where }),
    tx.enrollment.count({ where }),
    tx.review.count({ where }),
    tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM quiz_attempts WHERE "userId" = ${userId} AND score = total LIMIT 1`,
    tx.badgeAwarded.findMany({ where, select: { badgeId: true } }),
    tx.activityDay.findMany({ where, select: { day: true, seconds: true } }),
    tx.xpEvent.findMany({ where, select: { at: true } }),
  ]);

  const level = levelFromXp(xpAfter);
  const snapshot: Snapshot = {
    lessonsDone, certificates, enrollments, reviews, level,
    perfectQuiz: perfect.length > 0,
    bestStreak: bestStreak(activeDays(Object.fromEntries(activity.map((a) => [a.day, a.seconds])), xpDates.map((e) => e.at))),
  };
  const have = new Set(awarded.map((b) => b.badgeId));
  const unlocked = BADGES.filter((b) => !have.has(b.id) && b.test(snapshot));
  for (const b of unlocked) {
    await tx.badgeAwarded.create({ data: { userId, badgeId: b.id, awardedAt: ctx.now } });
    await notify(tx, userId, "badge", texts.badge(b.name), ctx.tick());
  }
  const levelBefore = levelFromXp(xpBefore);
  if (level > levelBefore) await notify(tx, userId, "xp", texts.levelUp(level), ctx.tick());

  return { xpGained: xpAfter - xpBefore, ...(level > levelBefore ? { levelUp: level } : {}), newBadges: unlocked.map((b) => b.id) };
}
