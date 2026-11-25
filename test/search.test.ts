// DB-free: Arabic-aware normalisation, scoring, query parsing, search columns and the cache.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseQuerySchema, RecommendedSchema, BySlugsSchema } from "../src/catalog/schemas.js";
import { courseSearchColumns } from "../src/catalog/search-columns.js";
import { createCache } from "../src/lib/cache.js";
import { normalize, scoreText, tokens } from "../src/lib/search.js";

describe("normalize", () => {
  it("unifies Arabic letter variants so أحمد matches احمد", () => {
    expect(normalize("أحمد")).toBe(normalize("احمد"));
    expect(normalize("إسلام آمن")).toBe("اسلام امن");
    expect(normalize("مدرسة")).toBe("مدرسه");
    expect(normalize("على")).toBe("علي");
  });

  it("strips diacritics and tatweel", () => {
    expect(normalize("مُحَمَّد")).toBe("محمد");
    expect(normalize("كـــتاب")).toBe("كتاب");
  });

  it("lower-cases, turns punctuation into spaces and collapses whitespace", () => {
    expect(normalize("  React.JS!!  Basics ")).toBe("react js basics");
    expect(normalize("C++ & C#")).toBe("c c");
    expect(normalize("   ")).toBe("");
  });
});

describe("scoring", () => {
  it("word-start matches score 3, inner matches 1, and every token must match", () => {
    expect(scoreText("react from scratch", ["react"])).toBe(3);
    expect(scoreText("react from scratch", ["scratch"])).toBe(3);
    expect(scoreText("preact basics", ["react"])).toBe(1);
    expect(scoreText("react from scratch", ["react", "nope"])).toBe(0);
    expect(scoreText("anything", [])).toBe(0);
  });

  it("tokens are normalised words", () => {
    expect(tokens(" Python  أحمد! ")).toEqual(["python", "احمد"]);
  });
});

describe("courseSearchColumns", () => {
  const c = { title: { en: "React Basics", ar: "أساسيات ريأكت" }, subtitle: { en: "Learn UI", ar: "تعلم" }, tags: ["JS", "Web"] };
  const name = { en: "Omar Haddad", ar: "عمر حداد" };

  it("searchText is title + tags; searchMeta is tags + subtitle + instructor name", () => {
    const cols = courseSearchColumns(c, name);
    expect(cols.searchText).toBe(normalize("React Basics أساسيات ريأكت JS Web"));
    expect(cols.searchMeta).toBe(normalize("JS Web Learn UI تعلم Omar Haddad عمر حداد"));
    expect(cols.searchMeta).toContain("omar haddad");
    expect(cols.searchText).not.toContain("omar");
  });
});

describe("course query parsing", () => {
  it("applies the frontend defaults", () => {
    expect(CourseQuerySchema.parse({})).toEqual({ sort: "popular", page: 1, pageSize: 9 });
  });

  it("splits comma lists and accepts repeated parameters", () => {
    const q = CourseQuerySchema.parse({ category: "development, design", level: ["beginner", "advanced"], language: "ar", price: "free", minRating: "4.5", page: "2", pageSize: "20" });
    expect(q).toMatchObject({ category: ["development", "design"], level: ["beginner", "advanced"], language: ["ar"], price: "free", minRating: 4.5, page: 2, pageSize: 20 });
    expect(CourseQuerySchema.parse({ category: "" }).category).toBeUndefined();
  });

  it("rejects values outside the contract", () => {
    for (const bad of [{ level: "expert" }, { sort: "random" }, { pageSize: "100" }, { price: "cheap" }, { language: "fr" }, { minRating: "9" }]) {
      expect(CourseQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("by-slugs dedupes and caps; recommended defaults", () => {
    expect(BySlugsSchema.parse({ slugs: "a,b,a" }).slugs).toEqual(["a", "b"]);
    expect(BySlugsSchema.parse({}).slugs).toEqual([]);
    expect(RecommendedSchema.parse({})).toEqual({ viewedCategories: [], excludeSlugs: [], limit: 4 });
  });
});

describe("createCache", () => {
  afterEach(() => vi.useRealTimers());

  it("serves repeats from memory until the TTL passes", async () => {
    vi.useFakeTimers();
    const cache = createCache({ ttlMs: 1000 });
    const load = vi.fn(async () => "v");
    await cache.get("k", load);
    await cache.get("k", load);
    expect([load.mock.calls.length, cache.hits, cache.misses]).toEqual([1, 1, 1]);
    vi.advanceTimersByTime(1001);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("clear() forgets everything, and a disabled cache always loads", async () => {
    const cache = createCache({ ttlMs: 60_000 });
    const load = vi.fn(async () => 1);
    await cache.get("k", load);
    cache.clear();
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
    cache.enabled = false;
    await cache.get("k", load);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failed load, and empties itself at the size limit", async () => {
    const cache = createCache({ ttlMs: 60_000, max: 2 });
    await expect(cache.get("bad", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(cache.size).toBe(0);
    await cache.get("a", async () => 1);
    await cache.get("b", async () => 2);
    await cache.get("c", async () => 3);
    expect(cache.size).toBe(1);
  });
});
