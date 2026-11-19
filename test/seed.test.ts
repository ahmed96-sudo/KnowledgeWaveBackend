// Needs the test database (docker compose up).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/auth/password.js";
import { prisma } from "../src/lib/prisma.js";
import { DEMO_PASSWORD, seedAll } from "../src/seed.js";
import { resetDb } from "./helpers/db.js";

let first: Awaited<ReturnType<typeof seedAll>>;

beforeAll(async () => {
  await resetDb();
  first = await seedAll();
}, 60_000);

afterAll(() => prisma.$disconnect());

describe("seedAll", () => {
  it("loads every file", () => {
    expect(first).toEqual({
      categories: 8, instructors: 12, courses: 26, lessons: 234, reviews: 104, roadmaps: 6,
      testimonials: 3, quizQuestions: 32, qaThreads: 26, users: 3, coupons: 2,
    });
  });

  it("stores prices as integer cents and keeps Localized as JSON", async () => {
    const c = await prisma.course.findUniqueOrThrow({ where: { slug: "javascript-complete-guide" } });
    expect([c.priceCents, c.originalPriceCents]).toEqual([4999, 8999]);
    expect(c.title).toMatchObject({ en: "Complete JavaScript Guide" });
    expect(c.quiz).toBeNull();
  });

  it("each course has 3 sections of 3 ordered lessons", async () => {
    const c = await prisma.course.findUniqueOrThrow({
      where: { slug: "react-from-scratch" },
      include: { sections: { orderBy: { position: "asc" }, include: { lessons: { orderBy: { position: "asc" } } } } },
    });
    expect(c.sections.map((s) => s.lessons.length)).toEqual([3, 3, 3]);
  });

  it("roadmap courses keep their order", async () => {
    const r = await prisma.roadmapCourse.findMany({ where: { roadmapSlug: "frontend-developer" }, orderBy: { position: "asc" } });
    expect(r.map((x) => x.courseSlug)).toEqual(["javascript-complete-guide", "react-from-scratch", "nodejs-express-backend"]);
  });

  it("creates the demo accounts with the demo password (hashed, never stored in clear)", async () => {
    const users = await prisma.user.findMany({ orderBy: { id: "asc" }, include: { settings: true } });
    expect(users.map((u) => [u.id, u.email, u.role, u.instructorId])).toEqual([
      ["u-admin", "admin@knowledgewave.dev", "admin", null],
      ["u-instructor", "instructor@knowledgewave.dev", "instructor", "omar-haddad"],
      ["u-student", "student@knowledgewave.dev", "student", null],
    ]);
    for (const u of users) {
      expect(u.passwordHash).not.toContain(DEMO_PASSWORD);
      expect(await verifyPassword(u.passwordHash, DEMO_PASSWORD)).toBe(true);
      expect(u.settings).toMatchObject({ weeklyGoal: 5, emailNotifications: true, productUpdates: false, autoplayNext: true });
    }
  });

  it("creates the coupons", async () => {
    const c = await prisma.coupon.findMany({ orderBy: { code: "asc" } });
    expect(c.map((x) => [x.code, x.percent, x.active])).toEqual([["STUDENT20", 20, true], ["WAVE10", 10, true]]);
  });

  it("is idempotent: a second run changes nothing and restores the demo password", async () => {
    await prisma.user.update({ where: { id: "u-student" }, data: { name: "Changed" } });
    expect(await seedAll()).toEqual(first);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-student" } })).name).toBe("Amira Student");
  }, 60_000);
});
