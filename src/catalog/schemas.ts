import { z } from "zod";
import { LevelSchema } from "../schemas/common.js";

/** `?a=x,y` (or repeated `?a=x&a=y`) -> ["x", "y"]; absent or empty -> undefined. */
const list = <T extends z.ZodType>(item: T) =>
  z
    .preprocess(
      (v) => {
        const parts = (Array.isArray(v) ? v.join(",") : typeof v === "string" ? v : "").split(",").map((s) => s.trim()).filter(Boolean);
        return parts.length ? parts : undefined;
      },
      z.array(item).optional(),
    );

const limit = (def: number) => z.coerce.number().int().min(1).max(20).default(def);

export const SORTS = ["popular", "rating", "newest", "price-asc", "price-desc"] as const;

export const CourseQuerySchema = z.object({
  q: z.string().optional(),
  category: list(z.string()),
  level: list(LevelSchema),
  language: list(z.enum(["en", "ar"])),
  price: z.enum(["free", "paid"]).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: z.enum(SORTS).default("popular"),
  page: z.coerce.number().int().default(1), // out-of-range pages are clamped, not rejected
  pageSize: z.coerce.number().int().min(1).max(50).default(9),
});
export type CourseQuery = z.infer<typeof CourseQuerySchema>;

export const BySlugsSchema = z.object({ slugs: list(z.string()).transform((v) => [...new Set(v ?? [])].slice(0, 50)) });
export const RecommendedSchema = z.object({
  viewedCategories: list(z.string()).transform((v) => v ?? []),
  excludeSlugs: list(z.string()).transform((v) => v ?? []),
  limit: limit(4),
});
export const RelatedSchema = z.object({ limit: limit(3) });
export const SearchSchema = z.object({ q: z.string().default(""), limit: limit(5) });
