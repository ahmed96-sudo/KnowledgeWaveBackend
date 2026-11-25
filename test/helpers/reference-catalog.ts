// REFERENCE implementation: the frontend's src/lib/catalog.ts and src/lib/search.ts logic, run in memory over Course[].
// The backend answers the same questions with SQL; test/catalog.test.ts checks both give identical results.
import { normalize, scoreText, tokens } from "../../src/lib/search.js";
import type { CourseQuery } from "../../src/catalog/schemas.js";
import type { Category, Course, Instructor } from "../../src/schemas/course.js";

const sorters: Record<CourseQuery["sort"], (a: Course, b: Course) => number> = {
  popular: (a, b) => b.students - a.students,
  rating: (a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount,
  newest: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  "price-asc": (a, b) => a.price - b.price,
  "price-desc": (a, b) => b.price - a.price,
};

export function queryCourses(all: Course[], query: CourseQuery) {
  const { q, category, level, language, price, minRating, sort, page, pageSize } = query;
  const nq = q ? normalize(q) : "";
  const matches = (c: Course, skip?: "category" | "level") =>
    (!nq || normalize(`${c.title.en} ${c.title.ar} ${c.tags.join(" ")}`).includes(nq)) &&
    (skip === "category" || !category?.length || category.includes(c.category)) &&
    (skip === "level" || !level?.length || level.includes(c.level)) &&
    (!language?.length || language.includes(c.language)) &&
    (!price || (price === "free" ? c.price === 0 : c.price > 0)) &&
    (!minRating || c.rating >= minRating);
  const filtered = all.filter((c) => matches(c)).sort(sorters[sort]);
  const count = (key: "category" | "level") => {
    const out: Record<string, number> = {};
    for (const c of all) if (matches(c, key)) out[c[key]] = (out[c[key]] ?? 0) + 1;
    return out;
  };
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  return {
    items: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    total: filtered.length,
    page: safePage,
    pageCount,
    facets: { category: count("category"), level: count("level") },
  };
}

export function recommendCourses(all: Course[], { viewedCategories = [], excludeSlugs = [], limit = 4 }: { viewedCategories?: string[]; excludeSlugs?: string[]; limit?: number } = {}) {
  const weight = new Map<string, number>();
  viewedCategories.forEach((c, i) => weight.set(c, (weight.get(c) ?? 0) + 1 + i * 0.01));
  return all
    .filter((c) => !excludeSlugs.includes(c.slug))
    .map((c) => ({ c, score: (weight.get(c.category) ?? 0) * 5 + c.rating + (c.bestseller ? 0.6 : 0) + Math.log10(c.students) / 3 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

export function searchCorpus(query: string, corpus: { courses: Course[]; categories: Category[]; instructors: Instructor[] }, limit = 5) {
  const q = tokens(query);
  if (q.length === 0) return { courses: [], categories: [], instructors: [] };
  const instructorName = new Map(corpus.instructors.map((i) => [i.id, normalize(`${i.name.en} ${i.name.ar}`)]));
  const courses = corpus.courses
    .map((c) => {
      const title = normalize(`${c.title.en} ${c.title.ar}`);
      const meta = normalize(`${c.tags.join(" ")} ${c.subtitle.en} ${c.subtitle.ar} ${instructorName.get(c.instructorId) ?? ""}`);
      const score = scoreText(title, q) * 3 + scoreText(meta, q);
      return { c, score: score + (score > 0 ? c.rating / 10 : 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
  const match = <T>(items: T[], text: (t: T) => string) => items.filter((i) => scoreText(normalize(text(i)), q) > 0).slice(0, 3);
  return {
    courses,
    categories: match(corpus.categories, (c) => `${c.name.en} ${c.name.ar}`),
    instructors: match(corpus.instructors, (i) => `${i.name.en} ${i.name.ar} ${i.headline.en}`),
  };
}
