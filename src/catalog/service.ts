import type { Prisma } from "../generated/prisma/client.js";
import { ApiError } from "../lib/errors.js";
import type { Localized } from "../lib/localized.js";
import { prisma } from "../lib/prisma.js";
import { normalize, scoreText, tokens } from "../lib/search.js";
import type { Course } from "../schemas/course.js";
import { catalogCache } from "./cache.js";
import { courseInclude, toCategory, toCourse, toInstructor, toReview, toRoadmap, toTestimonial } from "./mapper.js";
import type { CourseQuery } from "./schemas.js";
import { canView, publicWhere, visibleSlugs, type Viewer } from "./visibility.js";

/**
 * Filtering, facets, sorting and paging run in SQL. Behaviour is the frontend's `queryCourses` (test/catalog.test.ts
 * runs a copy of the frontend code against this on the same data). Ties fall back to `position` (catalog order).
 * Results that do not depend on the viewer are cached for 60 s (see catalog/cache.ts and lib/prisma.ts).
 */
const ORDER: Record<CourseQuery["sort"], Prisma.CourseOrderByWithRelationInput[]> = {
  popular: [{ students: "desc" }, { position: "asc" }],
  rating: [{ rating: "desc" }, { ratingCount: "desc" }, { position: "asc" }],
  newest: [{ updatedAt: "desc" }, { position: "asc" }], // YYYY-MM-DD strings sort chronologically
  "price-asc": [{ priceCents: "asc" }, { position: "asc" }],
  "price-desc": [{ priceCents: "desc" }, { position: "asc" }],
};

const tally = <K extends string>(groups: ({ _count: { _all: number } } & Record<K, string>)[], key: K) =>
  Object.fromEntries(groups.map((g) => [g[key], g._count._all]));

export const listCourses = (query: CourseQuery) =>
  catalogCache.get(`courses:${JSON.stringify(query)}`, async () => {
    const { q, category, level, language, price, minRating, sort, page, pageSize } = query;
    const nq = q ? normalize(q) : "";
    // `skip` leaves one filter out: facet counts ignore their own filter so the UI can show alternatives
    const where = (skip?: "category" | "level"): Prisma.CourseWhereInput => ({
      ...publicWhere,
      ...(nq ? { searchText: { contains: nq } } : {}),
      ...(skip !== "category" && category?.length ? { categorySlug: { in: category } } : {}),
      ...(skip !== "level" && level?.length ? { level: { in: level } } : {}),
      ...(language?.length ? { language: { in: language } } : {}),
      ...(price ? { priceCents: price === "free" ? 0 : { gt: 0 } } : {}),
      ...(minRating ? { rating: { gte: minRating } } : {}),
    });

    const [total, byCategory, byLevel] = await Promise.all([
      prisma.course.count({ where: where() }),
      prisma.course.groupBy({ by: ["categorySlug"], where: where("category"), _count: { _all: true } }),
      prisma.course.groupBy({ by: ["level"], where: where("level"), _count: { _all: true } }),
    ]);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), pageCount);
    const rows = await prisma.course.findMany({
      where: where(),
      orderBy: ORDER[sort],
      skip: (safePage - 1) * pageSize,
      take: pageSize,
      include: courseInclude,
    });
    return {
      items: rows.map((r) => toCourse(r)),
      total,
      page: safePage,
      pageCount,
      facets: { category: tally(byCategory, "categorySlug"), level: tally(byLevel, "level") },
    };
  });

const fullCoursesInOrder = async (slugs: string[]) => {
  const rows = await prisma.course.findMany({ where: { slug: { in: slugs } }, include: courseInclude });
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  return slugs.flatMap((s) => (bySlug.has(s) ? [toCourse(bySlug.get(s)!)] : []));
};

export const recommended = (input: { viewedCategories: string[]; excludeSlugs: string[]; limit: number }) =>
  catalogCache.get(`recommended:${JSON.stringify(input)}`, async () => {
    const { viewedCategories, excludeSlugs, limit } = input;
    const weight = new Map<string, number>();
    viewedCategories.forEach((c, i) => weight.set(c, (weight.get(c) ?? 0) + 1 + i * 0.01));
    // only the columns the score needs; the full courses are loaded for the winners
    const thin = await prisma.course.findMany({
      where: publicWhere,
      orderBy: { position: "asc" },
      select: { slug: true, categorySlug: true, rating: true, bestseller: true, students: true },
    });
    const slugs = thin
      .filter((c) => !excludeSlugs.includes(c.slug))
      .map((c) => ({ slug: c.slug, score: (weight.get(c.categorySlug) ?? 0) * 5 + c.rating + (c.bestseller ? 0.6 : 0) + Math.log10(c.students) / 3 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.slug);
    return fullCoursesInOrder(slugs);
  });

export async function getCourse(slug: string, viewer: Viewer): Promise<Course> {
  const row = await prisma.course.findUnique({ where: { slug }, include: courseInclude });
  if (!row || !(await canView(row, viewer))) throw new ApiError("notFound", "Course not found");
  return toCourse(row);
}

/** In the requested order; slugs that do not exist or that the caller may not see are silently left out. */
export async function getCoursesBySlugs(slugs: string[], viewer: Viewer): Promise<Course[]> {
  if (slugs.length === 0) return [];
  const rows = await prisma.course.findMany({ where: { slug: { in: slugs } }, include: courseInclude });
  const visible = await visibleSlugs(rows, viewer);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  return slugs.flatMap((s) => (visible.has(s) ? [toCourse(bySlug.get(s)!)] : []));
}

export async function getRelated(slug: string, limit: number, viewer: Viewer) {
  const base = await prisma.course.findUnique({ where: { slug } });
  if (!base || !(await canView(base, viewer))) throw new ApiError("notFound", "Course not found");
  return catalogCache.get(`related:${slug}:${limit}`, async () =>
    (await prisma.course.findMany({
      where: { ...publicWhere, categorySlug: base.categorySlug, slug: { not: slug } },
      orderBy: { position: "asc" },
      take: limit,
      include: courseInclude,
    })).map((r) => toCourse(r)),
  );
}

export async function getReviews(slug: string, viewer: Viewer) {
  const course = await prisma.course.findUnique({ where: { slug } });
  if (!course || !(await canView(course, viewer))) throw new ApiError("notFound", "Course not found");
  const rows = await prisma.review.findMany({
    where: { courseId: course.id, hiddenAt: null },
    orderBy: { position: "asc" },
    include: { user: { select: { name: true } } },
  });
  return rows.map(toReview);
}

export const getCategories = () =>
  catalogCache.get("categories", async () => (await prisma.category.findMany({ where: { deletedAt: null }, orderBy: { position: "asc" } })).map(toCategory));

export const getInstructors = () =>
  catalogCache.get("instructors", async () => (await prisma.instructor.findMany({ where: { deletedAt: null }, orderBy: { position: "asc" } })).map(toInstructor));

export const getInstructor = (id: string) =>
  catalogCache.get(`instructor:${id}`, async () => {
    const row = await prisma.instructor.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new ApiError("notFound", "Instructor not found");
    const courses = await prisma.course.findMany({ where: { ...publicWhere, instructorId: id }, orderBy: { position: "asc" }, include: courseInclude });
    return { instructor: toInstructor(row), courses: courses.map((c) => toCourse(c)) };
  });

export const getRoadmaps = () =>
  catalogCache.get("roadmaps", async () => (await prisma.roadmap.findMany({ orderBy: { position: "asc" }, include: { courses: true } })).map(toRoadmap));

export const getRoadmap = (slug: string) =>
  catalogCache.get(`roadmap:${slug}`, async () => {
    const row = await prisma.roadmap.findUnique({ where: { slug }, include: { courses: true } });
    if (!row) throw new ApiError("notFound", "Roadmap not found");
    const roadmap = toRoadmap(row);
    // public courses only, in roadmap order
    return { roadmap, courses: await fullCoursesInOrder(await publicSlugsIn(roadmap.courses)) };
  });

const publicSlugsIn = async (slugs: string[]) => {
  const ok = new Set((await prisma.course.findMany({ where: { ...publicWhere, slug: { in: slugs } }, select: { slug: true } })).map((c) => c.slug));
  return slugs.filter((s) => ok.has(s));
};

export const getTestimonials = () =>
  catalogCache.get("testimonials", async () => (await prisma.testimonial.findMany({ orderBy: { position: "asc" } })).map(toTestimonial));

/** The frontend's `searchCorpus`: every word must match, word-start matches rank higher, title counts 3x. */
export const search = (query: string, limit: number) =>
  catalogCache.get(`search:${tokens(query).join(" ")}:${limit}`, async () => {
    const q = tokens(query);
    if (q.length === 0) return { courses: [], categories: [], instructors: [] };

    // SQL finds a superset of the matches (every word appears in the title/tags or meta text); the exact scoring runs on that small set
    const candidates = await prisma.course.findMany({
      where: { ...publicWhere, AND: q.map((t) => ({ OR: [{ searchText: { contains: t } }, { searchMeta: { contains: t } }] })) },
      orderBy: { position: "asc" },
      select: { slug: true, title: true, searchMeta: true, rating: true },
    });
    const slugs = candidates
      .map((c) => {
        const title = normalize(`${(c.title as Localized).en} ${(c.title as Localized).ar}`);
        const score = scoreText(title, q) * 3 + scoreText(c.searchMeta, q);
        return { slug: c.slug, score: score + (score > 0 ? c.rating / 10 : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.slug);

    // ponytail: categories and instructors are matched in memory (small tables). Add a searchText column to
    // instructors if they ever number in the thousands.
    const match = <T>(items: T[], text: (t: T) => string) => items.filter((i) => scoreText(normalize(text(i)), q) > 0).slice(0, 3);
    const [categories, instructors] = await Promise.all([
      prisma.category.findMany({ where: { deletedAt: null }, orderBy: { position: "asc" } }),
      prisma.instructor.findMany({ where: { deletedAt: null }, orderBy: { position: "asc" } }),
    ]);
    return {
      courses: await fullCoursesInOrder(slugs),
      categories: match(categories, (c) => `${(c.name as Localized).en} ${(c.name as Localized).ar}`).map(toCategory),
      instructors: match(instructors, (i) => `${(i.name as Localized).en} ${(i.name as Localized).ar} ${(i.headline as Localized).en}`).map(toInstructor),
    };
  });


