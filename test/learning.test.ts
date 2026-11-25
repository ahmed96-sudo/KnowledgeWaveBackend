// Needs the test database (docker compose up).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { UserDataSchema } from "../src/schemas/learning.js";
import { seedAll } from "../src/seed.js";
import { resetDb } from "./helpers/db.js";
import { H, agentFor, createUser } from "./helpers/users.js";

const app = createApp();
const FREE = "graphic-design-essentials"; // price 0, 9 lessons
const PAID = "javascript-complete-guide";
const day = (n: number) => new Date(Date.now() - n * 86_400_000);
const r2 = (n: number) => Math.round(n * 100) / 100; // the service stores ratings rounded to 2 decimals

beforeAll(async () => {
  await resetDb();
  await seedAll();
}, 60_000);
afterAll(() => prisma.$disconnect());

/** A fresh learner (optionally enrolled) with a signed-in agent: every test gets its own user. */
async function learner(opts: { role?: "student" | "admin"; enrolled?: string[] } = {}) {
  const user = await createUser({ role: opts.role });
  for (const slug of opts.enrolled ?? []) await prisma.enrollment.create({ data: { userId: user.id, courseSlug: slug } });
  return { user, agent: await agentFor(app, user.email) };
}
type Agent = Awaited<ReturnType<typeof learner>>["agent"];
const data = async (agent: Agent) => (await agent.get("/api/me/learning")).body;
const lessonIds = async (slug: string) =>
  (await prisma.lesson.findMany({ where: { section: { course: { slug } } }, orderBy: [{ section: { position: "asc" } }, { position: "asc" }], select: { id: true } })).map((l) => l.id);
const complete = (agent: Agent, lessonId: string, courseSlug = FREE) => agent.post(`/api/me/lessons/${lessonId}/complete`).set(H).send({ courseSlug });

describe("GET /me/learning", () => {
  it("a new learner gets the empty record", async () => {
    const { agent } = await learner();
    const body = await data(agent);
    expect(body).toEqual({
      enrollments: [], progress: {}, lastLesson: {}, notes: [], wishlist: [], orders: [], reviews: {}, quizAttempts: [], xpEvents: [], badges: {},
      notifications: [], certificates: [], activity: {},
      settings: { weeklyGoal: 5, emailNotifications: true, productUpdates: false, autoplayNext: true }, bio: "",
    });
    expect(UserDataSchema.safeParse(body).success).toBe(true);
  });

  it("every /me endpoint needs a session; a banned user is refused", async () => {
    for (const [method, path] of [["get", "/learning"], ["post", "/enrollments"], ["put", "/progress"], ["post", "/notes"], ["put", "/wishlist/x"], ["patch", "/profile"]] as const) {
      expect((await (await import("supertest")).default(app)[method](`/api/me${path}`).set(H)).status, path).toBe(401);
    }
    const { user, agent } = await learner();
    await prisma.user.update({ where: { id: user.id }, data: { bannedAt: new Date() } });
    expect((await agent.get("/api/me/learning")).status).toBe(403);
  });
});

describe("enroll", () => {
  it("enrols in a free course: wishlist cleared, counters up, one notification", async () => {
    const { user, agent } = await learner();
    await prisma.wishlist.create({ data: { userId: user.id, courseSlug: FREE } });
    const before = await prisma.course.findUniqueOrThrow({ where: { slug: FREE }, include: { instructor: true } });

    const res = await agent.post("/api/me/enrollments").set(H).send({ slugs: [FREE] });
    expect([res.status, res.body]).toEqual([200, { xpGained: 0, newBadges: [] }]);

    const d = await data(agent);
    expect(d.enrollments.map((e: { slug: string }) => e.slug)).toEqual([FREE]);
    expect(d.wishlist).toEqual([]);
    expect(d.notifications).toHaveLength(1);
    expect(d.notifications[0]).toMatchObject({ kind: "course", read: false, title: { en: "You are enrolled!", ar: "تم تسجيلك في الدورة!" } });
    const after = await prisma.course.findUniqueOrThrow({ where: { slug: FREE }, include: { instructor: true } });
    expect([after.students - before.students, after.instructor.students - before.instructor.students]).toEqual([1, 1]);
  });

  it("is idempotent: enrolling again changes nothing (one row, one notification, counters once)", async () => {
    const { agent } = await learner();
    const before = (await prisma.course.findUniqueOrThrow({ where: { slug: FREE } })).students;
    await agent.post("/api/me/enrollments").set(H).send({ slugs: [FREE, FREE] });
    await agent.post("/api/me/enrollments").set(H).send({ slugs: [FREE] });
    const d = await data(agent);
    expect([d.enrollments.length, d.notifications.length]).toEqual([1, 1]);
    expect((await prisma.course.findUniqueOrThrow({ where: { slug: FREE } })).students).toBe(before + 1);
  });

  it("the third enrolment unlocks the collector badge", async () => {
    const { agent } = await learner({ enrolled: [FREE, "digital-marketing-101"] });
    const res = await agent.post("/api/me/enrollments").set(H).send({ slugs: ["sql-database-fundamentals"] });
    expect(res.body.newBadges).toEqual(["collector"]);
  });

  it("paid courses are for checkout, except for a real admin; unknown or hidden courses are 404", async () => {
    const { agent } = await learner();
    const paid = await agent.post("/api/me/enrollments").set(H).send({ slugs: [PAID] });
    expect([paid.status, paid.body.error.code]).toEqual([403, "forbidden"]);
    expect((await agent.post("/api/me/enrollments").set(H).send({ slugs: ["nope"] })).status).toBe(404);
    expect((await data(agent)).enrollments).toEqual([]);

    await prisma.course.update({ where: { slug: FREE }, data: { status: "draft" } });
    expect((await agent.post("/api/me/enrollments").set(H).send({ slugs: [FREE] })).status).toBe(404);
    const admin = await learner({ role: "admin" });
    expect((await admin.agent.post("/api/me/enrollments").set(H).send({ slugs: [PAID, FREE] })).status).toBe(200);
    await prisma.course.update({ where: { slug: FREE }, data: { status: "published" } });
  });

  it("validates the body", async () => {
    const { agent } = await learner();
    for (const body of [{}, { slugs: [] }, { slugs: "x" }, { slugs: Array.from({ length: 21 }, (_, i) => `c${i}`) }]) {
      expect((await agent.post("/api/me/enrollments").set(H).send(body)).status).toBe(422);
    }
  });

  it("an admin acting as a student enrols the STUDENT", async () => {
    const admin = await learner({ role: "admin" });
    const student = await createUser();
    await prisma.session.updateMany({ where: { userId: admin.user.id }, data: { actingAsUserId: student.id } });
    expect((await admin.agent.post("/api/me/enrollments").set(H).send({ slugs: [PAID] })).status).toBe(200); // paid is fine: the REAL user is an admin
    expect(await prisma.enrollment.count({ where: { userId: student.id } })).toBe(1);
    expect(await prisma.enrollment.count({ where: { userId: admin.user.id } })).toBe(0);
  });
});

describe("complete a lesson", () => {
  it("needs enrolment", async () => {
    const { agent } = await learner();
    const [first] = await lessonIds(FREE);
    const res = await complete(agent, first!);
    expect([res.status, res.body.error.code]).toEqual([403, "forbidden"]);
  });

  it("awards 20 XP and the first-lesson badge, moves lastLesson to the next lesson", async () => {
    const { agent } = await learner({ enrolled: [FREE] });
    const ids = await lessonIds(FREE);
    const res = await complete(agent, ids[0]!);
    expect([res.status, res.body]).toEqual([200, { xpGained: 20, newBadges: ["first-lesson"] }]);

    const d = await data(agent);
    expect(d.progress[ids[0]!]).toMatchObject({ completed: true, positionSec: 0 });
    expect(d.progress[ids[0]!].completedAt).toBeTypeOf("string");
    expect(d.lastLesson[FREE]).toBe(ids[1]);
    expect(d.xpEvents).toMatchObject([{ type: "lesson", amount: 20, refId: ids[0] }]);
    expect(Object.keys(d.badges)).toEqual(["first-lesson"]);
    expect(d.notifications[0]).toMatchObject({ kind: "badge", title: { en: "Badge unlocked" }, body: { en: "You earned “First step”." } });
  });

  it("is idempotent, and ignores a lesson that is not in the course", async () => {
    const { agent } = await learner({ enrolled: [FREE] });
    const ids = await lessonIds(FREE);
    await complete(agent, ids[0]!);
    const again = await complete(agent, ids[0]!);
    expect(again.body).toEqual({ xpGained: 0, newBadges: [] });

    const foreign = await complete(agent, (await lessonIds(PAID))[0]!);
    expect([foreign.status, foreign.body]).toEqual([200, { xpGained: 0, newBadges: [] }]);
    const d = await data(agent);
    expect([d.xpEvents.length, Object.keys(d.progress).length]).toEqual([1, 1]);
  });

  it("finishing the course gives a certificate, +150 XP, the graduate badge and a level-up", async () => {
    const { agent } = await learner({ enrolled: [FREE] });
    const ids = await lessonIds(FREE);
    expect(ids).toHaveLength(9);
    for (const id of ids.slice(0, 8)) await complete(agent, id);
    const last = await complete(agent, ids[8]!);

    expect(last.body).toMatchObject({ xpGained: 170, levelUp: 3, newBadges: ["first-course"], courseCompleted: FREE });
    expect(last.body.certificateId).toMatch(/^CERT-[0-9A-F]{10}$/);
    const d = await data(agent);
    expect(d.certificates).toMatchObject([{ id: last.body.certificateId, courseSlug: FREE }]);
    expect(d.xpEvents.reduce((n: number, e: { amount: number }) => n + e.amount, 0)).toBe(9 * 20 + 150);
    expect(d.xpEvents.filter((e: { type: string }) => e.type === "course")).toMatchObject([{ amount: 150, refId: FREE }]);
    const kinds = d.notifications.map((n: { kind: string }) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["certificate", "xp", "badge"]));
    expect(d.notifications.find((n: { kind: string }) => n.kind === "xp").title.en).toBe("Level 3 reached!");
    expect(UserDataSchema.safeParse(d).success).toBe(true);

    expect((await complete(agent, ids[8]!)).body).toEqual({ xpGained: 0, newBadges: [] }); // no second certificate
  });

  it("five simultaneous requests award the XP once", async () => {
    const { agent } = await learner({ enrolled: [FREE] });
    const [first] = await lessonIds(FREE);
    const results = await Promise.all(Array.from({ length: 5 }, () => complete(agent, first!)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.map((r) => r.body.xpGained).sort()).toEqual([0, 0, 0, 0, 20]);
    expect((await data(agent)).xpEvents).toHaveLength(1);
  });

  it("streak badges come from activity on consecutive days", async () => {
    const { user, agent } = await learner({ enrolled: [FREE] });
    await prisma.xpEvent.createMany({ data: [day(2), day(1)].map((at) => ({ userId: user.id, type: "lesson" as const, amount: 20, at, refId: "earlier" })) });
    const res = await complete(agent, (await lessonIds(FREE))[0]!);
    expect(res.body.newBadges.sort()).toEqual(["first-lesson", "streak-3"]);
  });
});

describe("PUT /me/progress", () => {
  const save = (agent: Agent, body: Record<string, unknown>) => agent.put("/api/me/progress").set(H).send(body);

  it("needs enrolment and a lesson of the course", async () => {
    const [first] = await lessonIds(FREE);
    const out = await learner();
    expect((await save(out.agent, { courseSlug: FREE, lessonId: first, positionSec: 5, watchedSec: 5, day: "2026-03-01" })).status).toBe(403);
    const inn = await learner({ enrolled: [FREE] });
    expect((await save(inn.agent, { courseSlug: FREE, lessonId: "nope", positionSec: 5, watchedSec: 5, day: "2026-03-01" })).status).toBe(404);
  });

  it("stores the whole-second position, remembers the lesson, and adds watch time (max 120 s per save)", async () => {
    const { agent } = await learner({ enrolled: [FREE] });
    const [first] = await lessonIds(FREE);
    expect((await save(agent, { courseSlug: FREE, lessonId: first, positionSec: 95.7, watchedSec: 200, day: "2026-03-01" })).status).toBe(204);
    let d = await data(agent);
    expect(d.progress[first!]).toEqual({ completed: false, positionSec: 95 });
    expect(d.lastLesson[FREE]).toBe(first);
    expect(d.activity).toEqual({ "2026-03-01": 120 });

    await save(agent, { courseSlug: FREE, lessonId: first, positionSec: 100, watchedSec: 10, day: "2026-03-01" });
    await save(agent, { courseSlug: FREE, lessonId: first, positionSec: 100, watchedSec: 0, day: "2026-03-02" });
    d = await data(agent);
    expect(d.activity).toEqual({ "2026-03-01": 130 }); // additive, and watchedSec 0 adds nothing
  });

  it("a completed lesson stays completed with position 0", async () => {
    const { agent } = await learner({ enrolled: [FREE] });
    const [first] = await lessonIds(FREE);
    await complete(agent, first!);
    await save(agent, { courseSlug: FREE, lessonId: first, positionSec: 50, watchedSec: 5, day: "2026-03-01" });
    expect((await data(agent)).progress[first!]).toMatchObject({ completed: true, positionSec: 0 });
  });

  it("validates the calendar day and the numbers", async () => {
    const { agent } = await learner({ enrolled: [FREE] });
    const [first] = await lessonIds(FREE);
    const ok = { courseSlug: FREE, lessonId: first, positionSec: 5, watchedSec: 5 };
    for (const bad of [{ day: "2026-02-30" }, { day: "01/03/2026" }, { day: "2026-3-1" }, { day: "2026-03-01", positionSec: -1 }, { day: "2026-03-01", watchedSec: "5" }]) {
      expect((await save(agent, { ...ok, ...bad })).status, JSON.stringify(bad)).toBe(422);
    }
  });
});

describe("notes", () => {
  it("add, list, delete: only your own, and deleting a missing one is fine", async () => {
    const [first] = await lessonIds(FREE);
    const me = await learner({ enrolled: [FREE] });
    const other = await learner({ enrolled: [FREE] });
    const res = await me.agent.post("/api/me/notes").set(H).send({ courseSlug: FREE, lessonId: first, atSec: 95.9, text: "  Remember this  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ courseSlug: FREE, lessonId: first, atSec: 95, text: "Remember this" });
    expect((await data(me.agent)).notes).toHaveLength(1);

    expect((await other.agent.delete(`/api/me/notes/${res.body.id}`).set(H)).status).toBe(204);
    expect((await data(me.agent)).notes).toHaveLength(1); // not theirs: untouched
    expect((await me.agent.delete(`/api/me/notes/${res.body.id}`).set(H)).status).toBe(204);
    expect((await data(me.agent)).notes).toEqual([]);
    expect((await me.agent.delete("/api/me/notes/missing").set(H)).status).toBe(204);
  });

  it("needs enrolment, a lesson of the course, and some text", async () => {
    const [first] = await lessonIds(FREE);
    const out = await learner();
    expect((await out.agent.post("/api/me/notes").set(H).send({ courseSlug: FREE, lessonId: first, atSec: 1, text: "x" })).status).toBe(403);
    const inn = await learner({ enrolled: [FREE] });
    expect((await inn.agent.post("/api/me/notes").set(H).send({ courseSlug: FREE, lessonId: "nope", atSec: 1, text: "x" })).status).toBe(404);
    expect((await inn.agent.post("/api/me/notes").set(H).send({ courseSlug: FREE, lessonId: first, atSec: 1, text: "   " })).status).toBe(422);
  });
});

describe("wishlist and notifications", () => {
  it("wishlist keeps the order things were added, is idempotent, and only takes public courses", async () => {
    const { agent } = await learner();
    for (const slug of [FREE, PAID, FREE]) expect((await agent.put(`/api/me/wishlist/${slug}`).set(H)).status).toBe(204);
    expect((await data(agent)).wishlist).toEqual([FREE, PAID]);
    expect((await agent.delete(`/api/me/wishlist/${FREE}`).set(H)).status).toBe(204);
    expect((await agent.delete(`/api/me/wishlist/${FREE}`).set(H)).status).toBe(204);
    expect((await data(agent)).wishlist).toEqual([PAID]);
    expect((await agent.put("/api/me/wishlist/nope").set(H)).status).toBe(404);
  });

  it("marks some or all notifications read", async () => {
    const { agent } = await learner();
    await agent.post("/api/me/enrollments").set(H).send({ slugs: [FREE] });
    await agent.post("/api/me/enrollments").set(H).send({ slugs: ["digital-marketing-101"] });
    let n = (await data(agent)).notifications;
    expect(n).toHaveLength(2);
    expect(n[0].at >= n[1].at).toBe(true); // newest first
    await agent.post("/api/me/notifications/read").set(H).send({ ids: [n[0].id] });
    n = (await data(agent)).notifications;
    expect(n.map((x: { read: boolean }) => x.read)).toEqual([true, false]);
    expect((await agent.post("/api/me/notifications/read").set(H)).status).toBe(204); // no body = all
    expect((await data(agent)).notifications.every((x: { read: boolean }) => x.read)).toBe(true);
  });
});

describe("reviews", () => {
  const review = (agent: Agent, slug: string, body: Record<string, unknown>) => agent.put(`/api/me/reviews/${slug}`).set(H).send(body);

  it("needs enrolment and a valid rating", async () => {
    const out = await learner();
    expect((await review(out.agent, FREE, { rating: 5, comment: "x" })).status).toBe(403);
    const inn = await learner({ enrolled: [FREE] });
    for (const body of [{ rating: 0, comment: "" }, { rating: 6, comment: "" }, { rating: 4.5, comment: "" }, { rating: 5, comment: "x".repeat(401) }]) {
      expect((await review(inn.agent, FREE, body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it("first review: 15 XP, reviewer badge, counters; a replacement: no XP, counters recomputed", async () => {
    const { user, agent } = await learner({ enrolled: [FREE] });
    const c0 = await prisma.course.findUniqueOrThrow({ where: { slug: FREE } });

    const first = await review(agent, FREE, { rating: 5, comment: "  Great  " });
    expect([first.status, first.body]).toEqual([200, { xpGained: 15, newBadges: ["reviewer"] }]);
    const c1 = await prisma.course.findUniqueOrThrow({ where: { slug: FREE } });
    expect(c1.ratingCount).toBe(c0.ratingCount + 1);
    expect(c1.rating).toBe(r2((c0.rating * c0.ratingCount + 5) / (c0.ratingCount + 1)));
    expect((await data(agent)).reviews[FREE]).toEqual({ rating: 5, comment: "Great", date: new Date().toISOString().slice(0, 10) });

    const second = await review(agent, FREE, { rating: 3, comment: "Changed my mind" });
    expect(second.body).toEqual({ xpGained: 0, newBadges: [] });
    const c2 = await prisma.course.findUniqueOrThrow({ where: { slug: FREE } });
    expect(c2.ratingCount).toBe(c1.ratingCount);
    expect(c2.rating).toBe(r2((c1.rating * c1.ratingCount - 5 + 3) / c1.ratingCount));
    expect(await prisma.review.count({ where: { userId: user.id } })).toBe(1);
    expect((await data(agent)).xpEvents.filter((e: { type: string }) => e.type === "review")).toHaveLength(1);

    const instructor = await prisma.instructor.findUniqueOrThrow({ where: { id: c2.instructorId } });
    const siblings = await prisma.course.findMany({ where: { instructorId: c2.instructorId } });
    const total = siblings.reduce((n, c) => n + c.ratingCount, 0);
    expect(instructor.rating).toBe(r2(siblings.reduce((n, c) => n + c.rating * c.ratingCount, 0) / total));
  });

  it("appears in the public reviews with the learner's name; an empty comment reads back empty", async () => {
    const { user, agent } = await learner({ enrolled: [FREE] });
    await prisma.user.update({ where: { id: user.id }, data: { name: "Review Writer" } });
    await review(agent, FREE, { rating: 4, comment: "" });
    expect((await data(agent)).reviews[FREE].comment).toBe("");
    const mine = (await agent.get(`/api/courses/${FREE}/reviews`)).body.at(-1);
    expect(mine).toMatchObject({ author: { en: "Review Writer" }, rating: 4, comment: { en: "—", ar: "—" } });
  });
});

describe("profile and settings", () => {
  it("PATCH /me/profile updates the name on the account and the bio / weekly goal on the settings", async () => {
    const { user, agent } = await learner();
    const res = await agent.patch("/api/me/profile").set(H).send({ name: "  New Name  ", bio: "Hello there", weeklyGoal: 12 });
    expect([res.status, res.body]).toEqual([200, { id: user.id, name: "New Name", email: user.email, role: "student" }]);
    expect((await agent.get("/api/auth/me")).body.user.name).toBe("New Name");
    const d = await data(agent);
    expect([d.bio, d.settings.weeklyGoal]).toEqual(["Hello there", 12]);
  });

  it("validates the profile", async () => {
    const { agent } = await learner();
    for (const bad of [{ name: "A" }, { bio: "x".repeat(241) }, { weeklyGoal: 0 }, { weeklyGoal: 31 }, { weeklyGoal: 2.5 }]) {
      const res = await agent.patch("/api/me/profile").set(H).send({ name: "Valid Name", bio: "", weeklyGoal: 5, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
  });

  it("PATCH /me/settings changes only what is sent and returns all four settings", async () => {
    const { agent } = await learner();
    const res = await agent.patch("/api/me/settings").set(H).send({ autoplayNext: false, weeklyGoal: 9 });
    expect(res.body).toEqual({ weeklyGoal: 9, emailNotifications: true, productUpdates: false, autoplayNext: false });
    expect((await agent.patch("/api/me/settings").set(H).send({})).body).toEqual(res.body);
    expect((await agent.patch("/api/me/settings").set(H).send({ weeklyGoal: 99 })).status).toBe(422);
    expect((await data(agent)).settings).toEqual(res.body);
  });
});

describe("acting as", () => {
  it("lesson completion by an admin acting as a student is recorded for the student", async () => {
    const admin = await learner({ role: "admin" });
    const student = await createUser();
    await prisma.enrollment.create({ data: { userId: student.id, courseSlug: FREE } });
    await prisma.session.updateMany({ where: { userId: admin.user.id }, data: { actingAsUserId: student.id } });
    const [first] = await lessonIds(FREE);
    expect((await complete(admin.agent, first!)).body.xpGained).toBe(20);
    expect(await prisma.lessonProgress.count({ where: { userId: student.id } })).toBe(1);
    expect(await prisma.lessonProgress.count({ where: { userId: admin.user.id } })).toBe(0);
  });
});
