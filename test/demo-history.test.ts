// Needs the test database (docker compose up).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getUserData } from "../src/learning/user-data.js";
import { prisma } from "../src/lib/prisma.js";
import { UserDataSchema } from "../src/schemas/learning.js";
import { seedAll } from "../src/seed.js";
import { seedDemoStudent } from "../src/seed-demo.js";
import { resetDb } from "./helpers/db.js";

const NOW = new Date("2026-06-15T20:00:00.000Z");

beforeAll(async () => {
  await resetDb();
  await seedAll();
}, 60_000);
afterAll(() => prisma.$disconnect());

describe("the demo student's history (built through the real learner services)", () => {
  it("matches the frontend's demo account", async () => {
    expect(await seedDemoStudent(prisma, NOW)).toEqual({ skipped: false });
    const d = await getUserData(prisma, "u-student");
    expect(UserDataSchema.safeParse(d).success).toBe(true);

    expect(d.enrollments.map((e) => e.slug)).toEqual(["ui-ux-design-figma", "javascript-complete-guide", "python-for-beginners"]);
    expect(Object.values(d.progress).filter((p) => p.completed)).toHaveLength(9 + 4 + 2);
    expect(d.certificates.map((c) => c.courseSlug)).toEqual(["ui-ux-design-figma"]);
    expect(d.reviews["ui-ux-design-figma"]).toMatchObject({ rating: 5, comment: "Clear and practical. The wireframing section was my favourite." });
    expect(d.notes).toHaveLength(1);
    expect(d.wishlist).toEqual(["seo-for-beginners", "machine-learning-for-everybody"]);
    expect(d.bio).toBe("Learning something new every day.");
  });

  it("has a 12-day streak ending today", async () => {
    const d = await getUserData(prisma, "u-student");
    const days = Object.keys(d.activity).sort();
    expect(days).toHaveLength(12);
    expect([days[0], days.at(-1)]).toEqual(["2026-06-04", "2026-06-15"]);
  });

  it("earned the XP, level and badges the rules give (no quiz yet: that arrives with the quiz service)", async () => {
    const d = await getUserData(prisma, "u-student");
    expect(d.xpEvents.reduce((n, e) => n + e.amount, 0)).toBe(15 * 20 + 150 + 15); // lessons + course + review
    expect(Object.keys(d.badges).sort()).toEqual(["collector", "first-course", "first-lesson", "marathon", "reviewer", "streak-3", "streak-7"]);
  });

  it("has a welcome notification and exactly two unread ones", async () => {
    const d = await getUserData(prisma, "u-student");
    expect(d.notifications.some((n) => n.kind === "system" && n.title.en === "Welcome to KnowledgeWave")).toBe(true);
    expect(d.notifications.filter((n) => !n.read)).toHaveLength(2);
  });

  it("is skipped when the student already has data", async () => {
    expect(await seedDemoStudent(prisma, NOW)).toEqual({ skipped: true });
    expect((await getUserData(prisma, "u-student")).enrollments).toHaveLength(3);
  });
});
