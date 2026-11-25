import { courseInclude } from "./catalog/mapper.js";
import { config } from "./config.js";
import { addNote, completeLesson, enroll, submitReview } from "./learning/service.js";
import { prisma } from "./lib/prisma.js";
import { assertDemoSeedAllowed } from "./seed.js";

type Db = typeof prisma;

/**
 * A lived-in demo account (the frontend's seedDemoStudent): one finished course, two in progress, a 12-day streak.
 * It calls the REAL learner services with backdated times, so the XP/badge/streak rules are not duplicated here.
 * Skipped when u-student already has data. (The 100% quiz attempt of the frontend's history is added with the quiz
 * service in Phase 6.)
 */
export async function seedDemoStudent(db: Db = prisma, now = new Date()) {
  assertDemoSeedAllowed(config.NODE_ENV);
  const userId = "u-student";
  if ((await db.enrollment.count({ where: { userId } })) > 0) return { skipped: true as const };

  const at = (daysAgo: number, hour = 19) => {
    const x = new Date(now);
    x.setUTCDate(x.getUTCDate() - daysAgo);
    x.setUTCHours(Math.min(hour, daysAgo === 0 ? now.getUTCHours() : 23), 15, 0, 0);
    return x;
  };
  const courseOf = (slug: string) => db.course.findUniqueOrThrow({ where: { slug }, include: courseInclude });
  const [figma, js, py] = await Promise.all([courseOf("ui-ux-design-figma"), courseOf("javascript-complete-guide"), courseOf("python-for-beginners")]);

  await enroll(userId, [figma.slug], { isAdmin: false, bypassPayment: true, now: at(12) });
  await enroll(userId, [js.slug], { isAdmin: false, bypassPayment: true, now: at(5) });
  await enroll(userId, [py.slug], { isAdmin: false, bypassPayment: true, now: at(2) });

  const plan: [typeof figma, number[]][] = [
    [figma, [11, 10, 9, 8, 8, 7, 6, 5, 5]],
    [js, [4, 3, 2, 1]],
    [py, [1, 0]],
  ];
  for (const [course, days] of plan) {
    const lessons = course.sections.flatMap((s) => s.lessons);
    for (const [i, daysAgo] of days.entries()) {
      const when = at(daysAgo, 18);
      await completeLesson(userId, course.slug, lessons[i]!.id, when);
      const day = when.toISOString().slice(0, 10);
      const seconds = Math.min(lessons[i]!.durationSec, 1800);
      await db.activityDay.upsert({ where: { userId_day: { userId, day } }, create: { userId, day, seconds }, update: { seconds: { increment: seconds } } });
    }
  }

  await submitReview(userId, figma.slug, { rating: 5, comment: "Clear and practical. The wireframing section was my favourite." }, at(4, 20));
  await addNote(userId, { courseSlug: js.slug, lessonId: js.sections[0]!.lessons[0]!.id, atSec: 95, text: "Remember: const for values that never get reassigned." }, at(4, 19));
  await db.wishlist.createMany({
    data: [
      { userId, courseSlug: "seo-for-beginners", addedAt: at(3) },
      { userId, courseSlug: "machine-learning-for-everybody", addedAt: at(3, 20) },
    ],
  });
  await db.userSettings.update({ where: { userId }, data: { bio: "Learning something new every day." } });
  await db.notification.create({
    data: {
      userId, kind: "system", at: at(12, 8), read: true,
      title: { en: "Welcome to KnowledgeWave", ar: "مرحباً بك في KnowledgeWave" },
      body: { en: "Pick up where you left off, or explore a roadmap.", ar: "أكمل من حيث توقفت أو استكشف خريطة طريق." },
    },
  });
  // everything already seen except the two newest notifications
  const newest = await db.notification.findMany({ where: { userId }, orderBy: [{ at: "desc" }, { id: "desc" }], select: { id: true } });
  await db.notification.updateMany({ where: { id: { in: newest.map((n) => n.id) } }, data: { read: true } });
  await db.notification.updateMany({ where: { id: { in: newest.slice(0, 2).map((n) => n.id) } }, data: { read: false } });
  return { skipped: false as const };
}
