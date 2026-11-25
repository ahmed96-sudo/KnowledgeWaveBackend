import type { Prisma } from "../generated/prisma/client.js";
import { fromCents } from "../lib/money.js";
import type { Localized } from "../lib/localized.js";
import type { VideoSource } from "../schemas/common.js";
import type { Category, Course, Instructor, Review, Roadmap, Testimonial } from "../schemas/course.js";

/** Include this to load a course with its ordered sections and lessons. */
export const courseInclude = {
  sections: { orderBy: { position: "asc" }, include: { lessons: { orderBy: { position: "asc" } } } },
} satisfies Prisma.CourseInclude;

export type CourseRow = Prisma.CourseGetPayload<{ include: typeof courseInclude }>;

/**
 * Database row -> the API `Course` (cents -> dollars, columns -> nested objects).
 * The instructor's quiz holds the answers, so it is only included for the owner/admin editing screens, never publicly.
 */
export function toCourse(c: CourseRow, opts: { includeQuiz?: boolean } = {}): Course {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title as Localized,
    subtitle: c.subtitle as Localized,
    description: c.description as Localized,
    category: c.categorySlug,
    instructorId: c.instructorId,
    level: c.level,
    language: c.language,
    price: fromCents(c.priceCents),
    ...(c.originalPriceCents !== null ? { originalPrice: fromCents(c.originalPriceCents) } : {}),
    rating: c.rating,
    ratingCount: c.ratingCount,
    students: c.students,
    durationSec: c.durationSec,
    updatedAt: c.updatedAt,
    thumbnail: c.thumbnail,
    previewVideo: c.previewVideo as VideoSource,
    outcomes: c.outcomes as Localized[],
    requirements: c.requirements as Localized[],
    tags: c.tags,
    credit: { channel: c.creditChannel },
    featured: c.featured,
    bestseller: c.bestseller,
    sections: c.sections.map((s) => ({
      id: s.id,
      title: s.title as Localized,
      lessons: s.lessons.map((l) => ({
        id: l.id,
        title: l.title as Localized,
        durationSec: l.durationSec,
        video: l.video as VideoSource,
        preview: l.preview,
        ...(l.thumbnail ? { thumbnail: l.thumbnail } : {}),
      })),
    })),
    status: c.status,
    ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
    ...(opts.includeQuiz && c.quiz ? { quiz: c.quiz as NonNullable<Course["quiz"]> } : {}),
  };
}

export const toCategory = (c: Prisma.CategoryGetPayload<object>): Category => ({
  slug: c.slug,
  name: c.name as Localized,
  description: c.description as Localized,
  icon: c.icon,
  ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
});

export const toInstructor = (i: Prisma.InstructorGetPayload<object>): Instructor => ({
  id: i.id,
  name: i.name as Localized,
  headline: i.headline as Localized,
  bio: i.bio as Localized,
  rating: i.rating,
  students: i.students,
  courses: i.courses,
  ...(i.deletedAt ? { deletedAt: i.deletedAt.toISOString() } : {}),
});

export const toRoadmap = (r: Prisma.RoadmapGetPayload<{ include: { courses: true } }>): Roadmap => ({
  slug: r.slug,
  title: r.title as Localized,
  description: r.description as Localized,
  level: r.level,
  icon: r.icon,
  courses: [...r.courses].sort((a, b) => a.position - b.position).map((c) => c.courseSlug),
});

export const toTestimonial = (t: Prisma.TestimonialGetPayload<object>): Testimonial => ({
  id: t.id,
  name: t.name as Localized,
  role: t.role as Localized,
  quote: t.quote as Localized,
});

/** A Localized comment may not be empty, so an empty one is shown as "—" (as the frontend does). */
export const nonEmpty = (l: Localized): Localized => ({ ...l, en: l.en || "—", ar: l.ar || "—" });

/** Learner-written reviews show the author's CURRENT name; seed/legacy reviews keep the stored one. */
export function toReview(r: Prisma.ReviewGetPayload<{ include: { user: { select: { name: true } } } }>): Review {
  return {
    id: r.id,
    courseId: r.courseId,
    author: r.user ? { en: r.user.name, ar: r.user.name } : (r.author as Localized),
    rating: r.rating,
    comment: nonEmpty(r.comment as Localized),
    date: r.date,
  };
}
