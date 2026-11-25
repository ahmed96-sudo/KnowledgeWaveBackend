import { randomBytes, randomUUID } from "node:crypto";
import { toUser } from "../auth/service.js";
import { courseInclude } from "../catalog/mapper.js";
import { publicWhere } from "../catalog/visibility.js";
import type { Prisma } from "../generated/prisma/client.js";
import { ApiError } from "../lib/errors.js";
import type { Localized } from "../lib/localized.js";
import { prisma } from "../lib/prisma.js";
import type { ProfileInput, ReviewInput, Settings } from "../schemas/learning.js";
import { XP } from "./gamification.js";
import { notify, texts } from "./notify.js";
import { settle, xpTotal, type Ctx, type Effects } from "./settle.js";
import { DEFAULT_SETTINGS } from "./user-data.js";

/**
 * Every learner action runs in ONE transaction that first takes a per-learner lock, so two tabs (or a retried
 * request) can never award the same XP, certificate or badge twice. `now` is injectable so the dev seed can backdate.
 * Phase 10b wraps this one function to audit what an admin does while acting as a learner.
 */
async function commit<T>(userId: string, now: Date, fn: (ctx: Ctx) => Promise<T>, settleWhen: (result: T) => boolean = () => true) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      let n = 0;
      const ctx: Ctx = { tx, userId, now, tick: () => new Date(now.getTime() + n++) };
      const xpBefore = await xpTotal(tx, userId);
      const result = await fn(ctx);
      const effects: Effects = settleWhen(result) ? await settle(ctx, xpBefore) : { xpGained: 0, newBadges: [] };
      return { result, effects };
    },
    { timeout: 20_000 },
  );
}

const xpEvent = (ctx: Ctx, type: "lesson" | "course" | "review" | "quiz", amount: number, refId: string) =>
  ctx.tx.xpEvent.create({ data: { userId: ctx.userId, type, amount, at: ctx.tick(), refId } });

const lessonsOf = (c: Prisma.CourseGetPayload<{ include: typeof courseInclude }>) => c.sections.flatMap((s) => s.lessons);
const round2 = (n: number) => Math.round(n * 100) / 100;
const today = (now: Date) => now.toISOString().slice(0, 10);

async function loadCourse(slug: string) {
  // soft-deleted courses still resolve: enrolled learners keep access to them
  const course = await prisma.course.findUnique({ where: { slug }, include: courseInclude });
  if (!course) throw new ApiError("notFound", "Course not found");
  return course;
}

async function requireEnrolled(ctx: Ctx, slug: string) {
  const e = await ctx.tx.enrollment.findUnique({ where: { userId_courseSlug: { userId: ctx.userId, courseSlug: slug } } });
  if (!e) throw new ApiError("forbidden", "You are not enrolled in this course");
}

// ---------------------------------------------------------------- enrolment

type Enrollable = { id: string; slug: string; title: unknown; instructorId: string };

/** Enrols the learner in each course they are not in yet (also used by checkout): wishlist, counters, notification. */
export async function enrollIn(ctx: Ctx, courses: Enrollable[]) {
  const have = new Set((await ctx.tx.enrollment.findMany({ where: { userId: ctx.userId, courseSlug: { in: courses.map((c) => c.slug) } }, select: { courseSlug: true } })).map((e) => e.courseSlug));
  for (const c of courses) {
    if (have.has(c.slug)) continue;
    await ctx.tx.enrollment.create({ data: { userId: ctx.userId, courseSlug: c.slug, enrolledAt: ctx.tick() } });
    await ctx.tx.wishlist.deleteMany({ where: { userId: ctx.userId, courseSlug: c.slug } });
    await ctx.tx.course.update({ where: { id: c.id }, data: { students: { increment: 1 } } });
    await ctx.tx.instructor.update({ where: { id: c.instructorId }, data: { students: { increment: 1 } } });
    await notify(ctx.tx, ctx.userId, "course", texts.enrolled(c.title as Localized), ctx.tick());
  }
}

/** Free courses only, unless the caller is a (real) admin; paid courses are enrolled by checkout. */
export async function enroll(userId: string, slugs: string[], opts: { isAdmin: boolean; bypassPayment?: boolean; now?: Date }): Promise<Effects> {
  const unique = [...new Set(slugs)];
  const rows = await prisma.course.findMany({ where: { slug: { in: unique }, deletedAt: null }, select: { id: true, slug: true, title: true, instructorId: true, status: true, priceCents: true } });
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const courses = unique.map((s) => {
    const c = bySlug.get(s);
    if (!c || (c.status !== "published" && !opts.isAdmin)) throw new ApiError("notFound", `Course not found: ${s}`);
    return c;
  });
  if (!opts.isAdmin && !opts.bypassPayment && courses.some((c) => c.priceCents > 0)) throw new ApiError("forbidden", "Paid courses are bought at checkout");
  return (await commit(userId, opts.now ?? new Date(), (ctx) => enrollIn(ctx, courses))).effects;
}

// ---------------------------------------------------------------- lessons and progress

export async function completeLesson(userId: string, courseSlug: string, lessonId: string, now = new Date()): Promise<Effects> {
  const course = await loadCourse(courseSlug);
  const lessons = lessonsOf(course);
  const index = lessons.findIndex((l) => l.id === lessonId);
  const { result, effects } = await commit(userId, now, async (ctx) => {
    await requireEnrolled(ctx, courseSlug);
    const done = {} as { certificateId?: string; courseCompleted?: string };
    if (index === -1) return done; // not a lesson of this course: nothing to do
    const prev = await ctx.tx.lessonProgress.findUnique({ where: { userId_lessonId: { userId, lessonId } } });
    if (prev?.completed) return done; // already completed: no change, no XP

    const at = ctx.tick();
    await ctx.tx.lessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: { userId, lessonId, completed: true, positionSec: 0, completedAt: at },
      update: { completed: true, positionSec: 0, completedAt: at },
    });
    await xpEvent(ctx, "lesson", XP.lesson, lessonId);
    const next = lessons[index + 1];
    if (next) await ctx.tx.lastLesson.upsert({ where: { userId_courseSlug: { userId, courseSlug } }, create: { userId, courseSlug, lessonId: next.id }, update: { lessonId: next.id } });

    const completed = await ctx.tx.lessonProgress.count({ where: { userId, completed: true, lessonId: { in: lessons.map((l) => l.id) } } });
    const hasCertificate = await ctx.tx.certificate.findUnique({ where: { userId_courseSlug: { userId, courseSlug } } });
    if (completed === lessons.length && !hasCertificate) {
      const cert = await ctx.tx.certificate.create({ data: { id: `CERT-${randomBytes(5).toString("hex").toUpperCase()}`, userId, courseSlug, issuedAt: ctx.tick() } });
      await xpEvent(ctx, "course", XP.courseComplete, courseSlug);
      await notify(ctx.tx, userId, "certificate", texts.certificate(course.title as Localized), ctx.tick());
      done.certificateId = cert.id;
      done.courseCompleted = courseSlug;
    }
    return done;
  });
  return { ...effects, ...result };
}

/** Resume position + watch time. Called every ~10 s while watching, so it only settles when a day first reaches 30 s of activity. */
export async function savePosition(userId: string, input: { courseSlug: string; lessonId: string; positionSec: number; watchedSec: number; day: string }, now = new Date()) {
  const { courseSlug, lessonId, day } = input;
  const course = await loadCourse(courseSlug);
  if (!lessonsOf(course).some((l) => l.id === lessonId)) throw new ApiError("notFound", "Lesson not found in this course");
  await commit(
    userId,
    now,
    async (ctx) => {
      await requireEnrolled(ctx, courseSlug);
      const prev = await ctx.tx.lessonProgress.findUnique({ where: { userId_lessonId: { userId, lessonId } } });
      const positionSec = prev?.completed ? 0 : Math.floor(Math.max(0, input.positionSec));
      await ctx.tx.lessonProgress.upsert({
        where: { userId_lessonId: { userId, lessonId } },
        create: { userId, lessonId, completed: false, positionSec },
        update: { positionSec },
      });
      await ctx.tx.lastLesson.upsert({ where: { userId_courseSlug: { userId, courseSlug } }, create: { userId, courseSlug, lessonId }, update: { lessonId } });

      const add = Math.round(Math.min(input.watchedSec, 120)); // one save counts at most 2 minutes
      if (add <= 0) return false;
      const before = (await ctx.tx.activityDay.findUnique({ where: { userId_day: { userId, day } } }))?.seconds ?? 0;
      await ctx.tx.activityDay.upsert({ where: { userId_day: { userId, day } }, create: { userId, day, seconds: add }, update: { seconds: before + add } });
      return before < 30 && before + add >= 30;
    },
    (crossed) => crossed,
  );
}

// ---------------------------------------------------------------- notes, wishlist, notifications

export async function addNote(userId: string, n: { courseSlug: string; lessonId: string; atSec: number; text: string }, now = new Date()) {
  const [enrolled, lesson] = await Promise.all([
    prisma.enrollment.findUnique({ where: { userId_courseSlug: { userId, courseSlug: n.courseSlug } } }),
    prisma.lesson.findFirst({ where: { id: n.lessonId, section: { course: { slug: n.courseSlug } } }, select: { id: true } }),
  ]);
  if (!lesson) throw new ApiError("notFound", "Lesson not found in this course");
  if (!enrolled) throw new ApiError("forbidden", "You are not enrolled in this course");
  const note = await prisma.note.create({ data: { userId, courseSlug: n.courseSlug, lessonId: n.lessonId, atSec: Math.floor(n.atSec), text: n.text, createdAt: now } });
  return { id: note.id, courseSlug: note.courseSlug, lessonId: note.lessonId, atSec: note.atSec, text: note.text, createdAt: note.createdAt.toISOString() };
}

/** Only your own notes; deleting one that is already gone is fine. */
export const deleteNote = (userId: string, id: string) => prisma.note.deleteMany({ where: { id, userId } });

export async function addToWishlist(userId: string, slug: string) {
  if (!(await prisma.course.findFirst({ where: { slug, ...publicWhere }, select: { id: true } }))) throw new ApiError("notFound", "Course not found");
  await prisma.wishlist.upsert({ where: { userId_courseSlug: { userId, courseSlug: slug } }, create: { userId, courseSlug: slug }, update: {} });
}
export const removeFromWishlist = (userId: string, slug: string) => prisma.wishlist.deleteMany({ where: { userId, courseSlug: slug } });

/** No `ids` = mark everything read. */
export const markNotificationsRead = (userId: string, ids?: string[]) =>
  prisma.notification.updateMany({ where: { userId, ...(ids ? { id: { in: ids } } : {}) }, data: { read: true } });

// ---------------------------------------------------------------- reviews, profile, settings

/** Creates or replaces the learner's review; XP only for the first review of a course. */
export async function submitReview(userId: string, slug: string, input: ReviewInput, now = new Date()): Promise<Effects> {
  const course = await loadCourse(slug);
  const { effects } = await commit(userId, now, async (ctx) => {
    await requireEnrolled(ctx, slug);
    const user = await ctx.tx.user.findUniqueOrThrow({ where: { id: userId } });
    const existing = await ctx.tx.review.findUnique({ where: { userId_courseId: { userId, courseId: course.id } } });
    const text = input.comment.trim() || "—"; // a Localized comment cannot be empty
    const data = { rating: input.rating, comment: { en: text, ar: text }, author: { en: user.name, ar: user.name }, date: today(now) };
    if (existing) await ctx.tx.review.update({ where: { id: existing.id }, data });
    else {
      await ctx.tx.review.create({ data: { id: `r-${randomUUID()}`, courseId: course.id, userId, ...data } });
      await xpEvent(ctx, "review", XP.review, slug);
    }

    // incremental counters: the seed's popularity numbers stay and real reviews move them
    const fresh = await ctx.tx.course.findUniqueOrThrow({ where: { id: course.id } });
    const count = fresh.ratingCount + (existing ? 0 : 1);
    const rating = round2((fresh.rating * fresh.ratingCount - (existing?.rating ?? 0) + input.rating) / count);
    await ctx.tx.course.update({ where: { id: course.id }, data: { rating, ratingCount: count } });
    const siblings = await ctx.tx.course.findMany({ where: { instructorId: course.instructorId }, select: { rating: true, ratingCount: true } });
    const total = siblings.reduce((n, c) => n + c.ratingCount, 0);
    if (total > 0) await ctx.tx.instructor.update({ where: { id: course.instructorId }, data: { rating: round2(siblings.reduce((n, c) => n + c.rating * c.ratingCount, 0) / total) } });
  });
  return effects;
}

/** The name lives on the account; bio and weekly goal on the learner settings. */
export async function updateProfile(userId: string, p: ProfileInput) {
  const [user] = await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { name: p.name.trim() } }),
    prisma.userSettings.upsert({ where: { userId }, create: { userId, bio: p.bio, weeklyGoal: p.weeklyGoal }, update: { bio: p.bio, weeklyGoal: p.weeklyGoal } }),
  ]);
  return toUser(user);
}

export async function updateSettings(userId: string, patch: Partial<Settings>): Promise<Settings> {
  const s = await prisma.userSettings.upsert({ where: { userId }, create: { userId, ...patch }, update: patch });
  return { weeklyGoal: s.weeklyGoal ?? DEFAULT_SETTINGS.weeklyGoal, emailNotifications: s.emailNotifications, productUpdates: s.productUpdates, autoplayNext: s.autoplayNext };
}
