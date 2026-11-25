import { readFile } from "node:fs/promises";
import { z } from "zod";
import { hashPassword } from "./auth/password.js";
import { courseSearchColumns } from "./catalog/search-columns.js";
import { config } from "./config.js";
import { Prisma } from "./generated/prisma/client.js";
import { toCents } from "./lib/money.js";
import { prisma } from "./lib/prisma.js";
import { CategorySchema, CourseSchema, InstructorSchema, QuizQuestionSchema, ReviewSchema, RoadmapSchema, TestimonialSchema } from "./schemas/course.js";
import { QaThreadSchema } from "./schemas/learning.js";
import { UserSchema } from "./schemas/user.js";

type Db = typeof prisma;

export const DEMO_PASSWORD = "demo1234";
const SEED_DIR = new URL("../seed/", import.meta.url);

const load = async <T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T>> =>
  schema.parse(JSON.parse(await readFile(new URL(file, SEED_DIR), "utf8")));

/** The demo data has accounts with a publicly known password, so it must never reach a live server. */
export function assertDemoSeedAllowed(nodeEnv: string) {
  if (nodeEnv === "production") {
    throw new Error("Refusing to load demo data (known demo passwords) when NODE_ENV=production. Use `npm run seed:base` to create the first admin.");
  }
}

/** Localized/VideoSource/... values are plain JSON; Prisma just needs the type assertion. */
const j = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Loads seed/*.json into the database. Every row is an upsert, so running it twice is safe (and resets seeded rows).
 * The dev learner history for u-student is added in Phase 5, when the real learner services exist.
 */
export async function seedAll(db: Db = prisma) {
  assertDemoSeedAllowed(config.NODE_ENV);
  const categories = await load("categories.json", z.array(CategorySchema));
  const instructors = await load("instructors.json", z.array(InstructorSchema));
  const courses = await load("courses.json", z.array(CourseSchema));
  const quizBank = await load("quizzes.json", z.record(z.string(), z.array(QuizQuestionSchema)));
  const reviews = await load("reviews.json", z.array(ReviewSchema));
  const roadmaps = await load("roadmaps.json", z.array(RoadmapSchema));
  const testimonials = await load("testimonials.json", z.array(TestimonialSchema));
  const threads = await load("qa.json", z.array(QaThreadSchema));
  const demoUsers = await load("demo-users.json", z.array(UserSchema));

  await db.$transaction(
    categories.map((c) => {
      const data = { name: j(c.name), description: j(c.description), icon: c.icon };
      return db.category.upsert({ where: { slug: c.slug }, create: { slug: c.slug, ...data }, update: data });
    }),
  );

  await db.$transaction(
    instructors.map((i) => {
      const data = { name: j(i.name), headline: j(i.headline), bio: j(i.bio), rating: i.rating, students: i.students, courses: i.courses };
      return db.instructor.upsert({ where: { id: i.id }, create: { id: i.id, ...data }, update: data });
    }),
  );

  const instructorNames = new Map(instructors.map((i) => [i.id, i.name]));
  for (const c of courses) {
    const data = {
      slug: c.slug,
      title: j(c.title),
      subtitle: j(c.subtitle),
      description: j(c.description),
      categorySlug: c.category,
      instructorId: c.instructorId,
      level: c.level,
      language: c.language,
      priceCents: toCents(c.price),
      originalPriceCents: c.originalPrice === undefined ? null : toCents(c.originalPrice),
      rating: c.rating,
      ratingCount: c.ratingCount,
      students: c.students,
      durationSec: c.durationSec,
      updatedAt: c.updatedAt,
      thumbnail: c.thumbnail,
      previewVideo: j(c.previewVideo),
      outcomes: j(c.outcomes),
      requirements: j(c.requirements),
      tags: c.tags,
      ...courseSearchColumns(c, instructorNames.get(c.instructorId)!),
      creditChannel: c.credit.channel,
      featured: c.featured,
      bestseller: c.bestseller,
      status: c.status,
      quiz: c.quiz ? j(c.quiz) : Prisma.DbNull,
    };
    await db.$transaction([
      db.course.upsert({ where: { id: c.id }, create: { id: c.id, ...data }, update: data }),
      ...c.sections.map((s, si) => {
        const d = { courseId: c.id, position: si, title: j(s.title) };
        return db.section.upsert({ where: { id: s.id }, create: { id: s.id, ...d }, update: d });
      }),
      ...c.sections.flatMap((s) =>
        s.lessons.map((l, li) => {
          const d = {
            sectionId: s.id,
            position: li,
            title: j(l.title),
            durationSec: l.durationSec,
            video: j(l.video),
            preview: l.preview,
            thumbnail: l.thumbnail ?? null,
          };
          return db.lesson.upsert({ where: { id: l.id }, create: { id: l.id, ...d }, update: d });
        }),
      ),
    ]);
  }

  await db.$transaction(
    Object.entries(quizBank).flatMap(([categorySlug, questions]) =>
      questions.map((q, position) => {
        const data = { categorySlug, position, q: j(q.q), options: j(q.options), answer: q.answer };
        return db.quizBankQuestion.upsert({ where: { id: q.id }, create: { id: q.id, ...data }, update: data });
      }),
    ),
  );

  await db.$transaction(
    reviews.map((r) => {
      const data = { courseId: r.courseId, userId: null, author: j(r.author), rating: r.rating, comment: j(r.comment), date: r.date };
      return db.review.upsert({ where: { id: r.id }, create: { id: r.id, ...data }, update: data });
    }),
  );

  await db.$transaction(
    roadmaps.flatMap((r) => {
      const data = { title: j(r.title), description: j(r.description), level: r.level, icon: r.icon };
      return [
        db.roadmap.upsert({ where: { slug: r.slug }, create: { slug: r.slug, ...data }, update: data }),
        ...r.courses.map((courseSlug, position) =>
          db.roadmapCourse.upsert({
            where: { roadmapSlug_courseSlug: { roadmapSlug: r.slug, courseSlug } },
            create: { roadmapSlug: r.slug, courseSlug, position },
            update: { position },
          }),
        ),
      ];
    }),
  );

  await db.$transaction(
    testimonials.map((t) => {
      const data = { name: j(t.name), role: j(t.role), quote: j(t.quote) };
      return db.testimonial.upsert({ where: { id: t.id }, create: { id: t.id, ...data }, update: data });
    }),
  );

  await db.$transaction(
    threads.flatMap((t) => {
      const data = { courseSlug: t.courseSlug, lessonId: t.lessonId, author: t.author, text: t.text, at: new Date(t.at), resolved: t.resolved ?? false };
      return [
        db.qaThread.upsert({ where: { id: t.id }, create: { id: t.id, ...data }, update: data }),
        ...t.replies.map((r) => {
          const d = { threadId: t.id, author: r.author, role: r.role, text: r.text, at: new Date(r.at) };
          return db.qaReply.upsert({ where: { id: r.id }, create: { id: r.id, ...d }, update: d });
        }),
      ];
    }),
  );

  const passwordHash = await hashPassword(DEMO_PASSWORD); // one hash shared by the three demo accounts
  await db.$transaction(
    demoUsers.flatMap((u) => {
      const data = { name: u.name, email: u.email.toLowerCase(), role: u.role, instructorId: u.instructorId ?? null, passwordHash };
      return [
        db.user.upsert({ where: { id: u.id }, create: { id: u.id, createdAt: new Date("2026-01-01T00:00:00.000Z"), ...data }, update: data }),
        db.userSettings.upsert({ where: { userId: u.id }, create: { userId: u.id }, update: {} }),
      ];
    }),
  );

  await db.$transaction(
    [
      { code: "WAVE10", percent: 10 },
      { code: "STUDENT20", percent: 20 },
    ].map((c) =>
      db.coupon.upsert({ where: { code: c.code }, create: { ...c, active: true }, update: { percent: c.percent, active: true, deletedAt: null } }),
    ),
  );

  const [categoriesN, instructorsN, coursesN, lessonsN, reviewsN, roadmapsN, testimonialsN, quizN, threadsN, usersN, couponsN] =
    await Promise.all([
      db.category.count(),
      db.instructor.count(),
      db.course.count(),
      db.lesson.count(),
      db.review.count(),
      db.roadmap.count(),
      db.testimonial.count(),
      db.quizBankQuestion.count(),
      db.qaThread.count(),
      db.user.count(),
      db.coupon.count(),
    ]);
  return {
    categories: categoriesN,
    instructors: instructorsN,
    courses: coursesN,
    lessons: lessonsN,
    reviews: reviewsN,
    roadmaps: roadmapsN,
    testimonials: testimonialsN,
    quizQuestions: quizN,
    qaThreads: threadsN,
    users: usersN,
    coupons: couponsN,
  };
}
