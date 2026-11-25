// Needs the test database (docker compose up). Compares the SQL implementation with a copy of the frontend's
// in-memory catalog code (test/helpers/reference-catalog.ts) on the seeded data.
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { catalogCache } from "../src/catalog/cache.js";
import { courseInclude, toCategory, toCourse, toInstructor } from "../src/catalog/mapper.js";
import { CourseQuerySchema } from "../src/catalog/schemas.js";
import { courseSearchColumns } from "../src/catalog/search-columns.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "../src/lib/prisma.js";
import type { Localized } from "../src/lib/localized.js";
import { CourseSchema } from "../src/schemas/course.js";
import { seedAll } from "../src/seed.js";
import { resetDb } from "./helpers/db.js";
import { agentFor, createUser } from "./helpers/users.js";
import { queryCourses, recommendCourses, searchCorpus } from "./helpers/reference-catalog.js";

const app = createApp();
const get = (path: string) => request(app).get(`/api${path}`);

const publicCourses = async () =>
  (await prisma.course.findMany({ where: { status: "published", deletedAt: null }, orderBy: { position: "asc" }, include: courseInclude })).map((r) => toCourse(r));

beforeAll(async () => {
  await resetDb();
  await seedAll();
}, 60_000);
afterAll(() => prisma.$disconnect());

describe("GET /courses matches the frontend's queryCourses", () => {
  const arabic = encodeURIComponent("جافاسكريبت");
  const cases = [
    "", "?q=react", `?q=${arabic}`, "?q=javascript&sort=rating&level=beginner", "?q=zzzz", "?q=!!!",
    "?category=development", "?category=development,design", "?level=beginner", "?level=beginner,advanced&language=ar",
    "?price=free", "?price=paid&minRating=4.5", "?minRating=4.8", "?language=en",
    "?sort=rating", "?sort=newest", "?sort=price-asc", "?sort=price-desc", "?sort=popular",
    "?page=2", "?page=3&pageSize=5", "?page=99", "?page=0", "?pageSize=50", "?category=design&price=free&sort=price-desc&pageSize=3",
  ];
  for (const qs of cases) {
    it(`/courses${qs || " (defaults)"}`, async () => {
      const expected = queryCourses(await publicCourses(), CourseQuerySchema.parse(Object.fromEntries(new URLSearchParams(qs))));
      const res = await get(`/courses${qs}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected);
    });
  }

  it("the default page is 9 of 26 and facets cover the whole catalog", async () => {
    const { body } = await get("/courses");
    expect([body.items.length, body.total, body.pageCount]).toEqual([9, 26, 3]);
    expect((Object.values(body.facets.category) as number[]).reduce((a, b) => a + b, 0)).toBe(26);
  });

  it("a facet ignores its own filter", async () => {
    const all = (await get("/courses")).body.facets.category;
    const filtered = (await get("/courses?category=design")).body.facets.category;
    expect(filtered).toEqual(all);
  });

  it("rejects values outside the contract", async () => {
    for (const qs of ["?level=expert", "?sort=random", "?pageSize=100"]) {
      const res = await get(`/courses${qs}`);
      expect([res.status, res.body.error.code]).toEqual([422, "validation"]);
    }
  });
});

describe("contract and leaks", () => {
  it("every course the API returns satisfies the frontend's CourseSchema", async () => {
    const { body } = await get("/courses?pageSize=50");
    expect(body.items).toHaveLength(26);
    for (const c of body.items) expect(CourseSchema.safeParse(c).success, c.slug).toBe(true);
    expect(CourseSchema.safeParse((await get("/courses/javascript-complete-guide")).body).success).toBe(true);
  });

  it("returns prices in dollars and never includes quiz answers", async () => {
    await prisma.course.update({ where: { slug: "javascript-complete-guide" }, data: { quiz: [{ id: "q1", q: { en: "Q", ar: "س" }, options: [], answer: 0 }] } });
    const { body } = await get("/courses/javascript-complete-guide");
    expect([body.price, body.originalPrice]).toEqual([49.99, 89.99]);
    expect(body).not.toHaveProperty("quiz");
    expect(JSON.stringify((await get("/courses?pageSize=50")).body)).not.toContain('"answer"');
    await prisma.course.update({ where: { slug: "javascript-complete-guide" }, data: { quiz: Prisma.DbNull } });
  });

  it("the stored search columns equal what courseSearchColumns computes (no write path forgot them)", async () => {
    const instructors = new Map((await prisma.instructor.findMany()).map((i) => [i.id, i.name as Localized]));
    for (const c of await prisma.course.findMany()) {
      expect({ searchText: c.searchText, searchMeta: c.searchMeta }, c.slug).toEqual(
        courseSearchColumns({ title: c.title as Localized, subtitle: c.subtitle as Localized, tags: c.tags }, instructors.get(c.instructorId)!),
      );
    }
  });
});

describe("recommended, related, by-slugs, search", () => {
  it("/courses/recommended matches recommendCourses (and is not read as a slug)", async () => {
    const all = await publicCourses();
    const cases: [string, Parameters<typeof recommendCourses>[1]][] = [
      ["", {}],
      ["?viewedCategories=development,design&excludeSlugs=react-from-scratch&limit=6", { viewedCategories: ["development", "design"], excludeSlugs: ["react-from-scratch"], limit: 6 }],
      ["?viewedCategories=design&viewedCategories=design&limit=3", { viewedCategories: ["design", "design"], limit: 3 }],
    ];
    for (const [qs, input] of cases) {
      const res = await get(`/courses/recommended${qs}`);
      expect(res.status).toBe(200);
      expect(res.body.map((c: { slug: string }) => c.slug)).toEqual(recommendCourses(all, input).map((c) => c.slug));
    }
  });

  it("/courses/:slug/related = same category, not itself, catalog order", async () => {
    const all = await publicCourses();
    const base = all.find((c) => c.slug === "react-from-scratch")!;
    const res = await get("/courses/react-from-scratch/related?limit=2");
    expect(res.body.map((c: { slug: string }) => c.slug)).toEqual(all.filter((c) => c.category === base.category && c.slug !== base.slug).slice(0, 2).map((c) => c.slug));
    expect((await get("/courses/nope/related")).status).toBe(404);
  });

  it("/courses/by-slugs keeps the requested order, dedupes and skips unknown slugs", async () => {
    const res = await get("/courses/by-slugs?slugs=react-from-scratch,nope,javascript-complete-guide,react-from-scratch");
    expect(res.body.map((c: { slug: string }) => c.slug)).toEqual(["react-from-scratch", "javascript-complete-guide"]);
    expect((await get("/courses/by-slugs")).body).toEqual([]);
  });

  it("/search matches the frontend's searchCorpus (title, tags, subtitle, instructor name)", async () => {
    const corpus = {
      courses: await publicCourses(),
      categories: (await prisma.category.findMany({ where: { deletedAt: null }, orderBy: { position: "asc" } })).map(toCategory),
      instructors: (await prisma.instructor.findMany({ where: { deletedAt: null }, orderBy: { position: "asc" } })).map(toInstructor),
    };
    const ids = (r: ReturnType<typeof searchCorpus>) => ({ courses: r.courses.map((c) => c.slug), categories: r.categories.map((c) => c.slug), instructors: r.instructors.map((i) => i.id) });
    for (const q of ["omar", "react", "جافاسكريبت", "design", "py", "layla", "a", "zzzzz", "   ", "web development", "OMAR haddad", "احمد"]) {
      const res = await get(`/search?q=${encodeURIComponent(q)}&limit=5`);
      expect(res.status, q).toBe(200);
      expect(ids(res.body), q).toEqual(ids(searchCorpus(q, corpus, 5)));
    }
    expect(ids((await get("/search?q=a&limit=2")).body).courses).toHaveLength(2);
  });

  it("searching an instructor's name finds their courses", async () => {
    const res = await get("/search?q=omar");
    expect(res.body.instructors.map((i: { id: string }) => i.id)).toContain("omar-haddad");
    expect(res.body.courses.length).toBeGreaterThan(0);
  });
});

describe("categories, instructors, roadmaps, testimonials, reviews", () => {
  it("lists come back in catalog (seed) order", async () => {
    const cats = (await get("/categories")).body.map((c: { slug: string }) => c.slug);
    const seeded = (await prisma.category.findMany({ orderBy: { position: "asc" } })).map((c) => c.slug);
    expect(cats).toEqual(seeded);
    expect(cats[0]).toBe("development");
    expect((await get("/instructors")).body).toHaveLength(12);
    expect((await get("/testimonials")).body.map((t: { id: string }) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("deleted categories and instructors are hidden", async () => {
    await prisma.category.update({ where: { slug: "design" }, data: { deletedAt: new Date() } });
    expect((await get("/categories")).body.map((c: { slug: string }) => c.slug)).not.toContain("design");
    await prisma.category.update({ where: { slug: "design" }, data: { deletedAt: null } });
    expect((await get("/instructors/nope")).status).toBe(404);
  });

  it("/instructors/:id returns the profile and only public courses", async () => {
    const { body } = await get("/instructors/omar-haddad");
    expect(body.instructor).toMatchObject({ id: "omar-haddad", courses: 2 });
    expect(body.courses).toHaveLength(2);
  });

  it("/roadmaps keep course order; /roadmaps/:slug returns the public courses in that order", async () => {
    const list = (await get("/roadmaps")).body;
    expect(list).toHaveLength(6);
    expect(list[0]).toMatchObject({ slug: "frontend-developer", courses: ["javascript-complete-guide", "react-from-scratch", "nodejs-express-backend"] });
    const detail = (await get("/roadmaps/frontend-developer")).body;
    expect(detail.courses.map((c: { slug: string }) => c.slug)).toEqual(list[0].courses);
    expect((await get("/roadmaps/nope")).status).toBe(404);
  });

  it("reviews: seed order first, hidden ones excluded, learner reviews appended with the CURRENT name and '—' for an empty comment", async () => {
    const course = await prisma.course.findUniqueOrThrow({ where: { slug: "react-from-scratch" } });
    const seeded = await prisma.review.findMany({ where: { courseId: course.id }, orderBy: { position: "asc" } });
    await prisma.review.update({ where: { id: seeded[0]!.id }, data: { hiddenAt: new Date() } });
    const learner = await createUser({ name: "Amira" });
    await prisma.review.create({ data: { id: "r-learner", courseId: course.id, userId: learner.id, author: { en: "old", ar: "old" }, rating: 5, comment: { en: "", ar: "" }, date: "2026-02-02" } });

    let reviews = (await get("/courses/react-from-scratch/reviews")).body;
    expect(reviews.map((r: { id: string }) => r.id)).toEqual([...seeded.slice(1).map((r) => r.id), "r-learner"]);
    expect(reviews.at(-1)).toMatchObject({ author: { en: "Amira", ar: "Amira" }, comment: { en: "—", ar: "—" }, rating: 5, date: "2026-02-02" });

    await prisma.user.update({ where: { id: learner.id }, data: { name: "Amira Renamed" } });
    reviews = (await get("/courses/react-from-scratch/reviews")).body;
    expect(reviews.at(-1).author.en).toBe("Amira Renamed");
    await prisma.review.update({ where: { id: seeded[0]!.id }, data: { hiddenAt: null } });
  });
});

describe("visibility (BACKEND_SPEC §2.5)", () => {
  const slug = "react-from-scratch";
  afterEach(async () => {
    await prisma.course.update({ where: { slug }, data: { status: "published", deletedAt: null } });
    await prisma.enrollment.deleteMany({ where: { courseSlug: slug } });
  });

  it("a draft is hidden from guests and lists, visible to the owner, an admin and enrolled learners", async () => {
    const course = await prisma.course.update({ where: { slug }, data: { status: "draft" } });
    const owner = await createUser({ role: "instructor" });
    await prisma.user.update({ where: { id: owner.id }, data: { instructorId: course.instructorId } });
    const admin = await createUser({ role: "admin" });
    const enrolled = await createUser();
    await prisma.enrollment.create({ data: { userId: enrolled.id, courseSlug: slug } });
    const stranger = await createUser();

    expect((await get(`/courses/${slug}`)).status).toBe(404);
    expect((await get(`/courses/${slug}/reviews`)).status).toBe(404);
    expect((await get("/courses?pageSize=50")).body.items.map((c: { slug: string }) => c.slug)).not.toContain(slug);
    expect((await get(`/courses/by-slugs?slugs=${slug}`)).body).toEqual([]);

    for (const u of [owner, admin, enrolled]) {
      const agent = await agentFor(app, u.email);
      expect((await agent.get(`/api/courses/${slug}`)).status, u.role).toBe(200);
      expect((await agent.get(`/api/courses/by-slugs?slugs=${slug}`)).body, u.role).toHaveLength(1);
    }
    expect((await (await agentFor(app, stranger.email)).get(`/api/courses/${slug}`)).status).toBe(404);
  });

  it("a soft-deleted course is visible only to enrolled learners", async () => {
    const course = await prisma.course.update({ where: { slug }, data: { deletedAt: new Date() } });
    const owner = await createUser({ role: "instructor" });
    await prisma.user.update({ where: { id: owner.id }, data: { instructorId: course.instructorId } });
    const admin = await createUser({ role: "admin" });
    const enrolled = await createUser();
    await prisma.enrollment.create({ data: { userId: enrolled.id, courseSlug: slug } });

    expect((await get(`/courses/${slug}`)).status).toBe(404);
    expect((await (await agentFor(app, owner.email)).get(`/api/courses/${slug}`)).status).toBe(404);
    expect((await (await agentFor(app, admin.email)).get(`/api/courses/${slug}`)).status).toBe(404);
    expect((await (await agentFor(app, enrolled.email)).get(`/api/courses/${slug}`)).status).toBe(200);
  });

  it("an admin acting as a student still gets admin visibility; a banned user is treated as a guest", async () => {
    await prisma.course.update({ where: { slug }, data: { status: "draft" } });
    const admin = await createUser({ role: "admin" });
    const student = await createUser();
    const agent = await agentFor(app, admin.email);
    await prisma.session.updateMany({ where: { userId: admin.id }, data: { actingAsUserId: student.id } });
    expect((await agent.get(`/api/courses/${slug}`)).status).toBe(200);

    const banned = await createUser({ role: "admin" });
    const bannedAgent = await agentFor(app, banned.email);
    await prisma.user.update({ where: { id: banned.id }, data: { bannedAt: new Date() } });
    expect((await bannedAgent.get(`/api/courses/${slug}`)).status).toBe(404);
  });
});

describe("cache", () => {
  afterEach(() => {
    catalogCache.enabled = false;
    catalogCache.clear();
  });

  it("serves repeats from memory and is cleared by any catalog write, but not by reads", async () => {
    catalogCache.enabled = true;
    catalogCache.clear();
    const before = catalogCache.hits;
    const first = (await get("/categories")).body;
    await get("/categories");
    expect(catalogCache.hits).toBe(before + 1);

    await prisma.category.findMany(); // a read does not clear it
    expect(catalogCache.size).toBeGreaterThan(0);

    await prisma.category.update({ where: { slug: first[0].slug }, data: { icon: "changed-icon" } });
    expect(catalogCache.size).toBe(0);
    expect((await get("/categories")).body[0].icon).toBe("changed-icon");
    await prisma.category.update({ where: { slug: first[0].slug }, data: { icon: first[0].icon } });
  });

  it("a learner's enrollment changes the cached course list (students counter) after the write", async () => {
    catalogCache.enabled = true;
    catalogCache.clear();
    const slug = "javascript-complete-guide";
    const before = (await get(`/courses?q=${encodeURIComponent("complete javascript guide")}`)).body.items[0].students;
    await prisma.course.update({ where: { slug }, data: { students: { increment: 1 } } });
    expect((await get(`/courses?q=${encodeURIComponent("complete javascript guide")}`)).body.items[0].students).toBe(before + 1);
  });
});
