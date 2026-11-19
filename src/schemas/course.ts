// Appendix A of BACKEND_SPEC.md (verbatim from the frontend's src/lib/schemas/course.ts).
import { z } from "zod";
import { LevelSchema, LocalizedSchema, VideoSourceSchema } from "./common.js";

export const CategorySchema = z.object({
  slug: z.string(),
  name: LocalizedSchema,
  description: LocalizedSchema,
  /** lucide-react icon name, resolved in the UI. */
  icon: z.string(),
  /** Soft delete: admins can restore it from the audit log. */
  deletedAt: z.string().optional(),
});
export type Category = z.infer<typeof CategorySchema>;

export const InstructorSchema = z.object({
  id: z.string(),
  name: LocalizedSchema,
  headline: LocalizedSchema,
  bio: LocalizedSchema,
  rating: z.number().min(0).max(5),
  students: z.number().int().nonnegative(),
  courses: z.number().int().nonnegative(),
  deletedAt: z.string().optional(),
});
export type Instructor = z.infer<typeof InstructorSchema>;

export const LessonSchema = z.object({
  id: z.string(),
  title: LocalizedSchema,
  durationSec: z.number().int().positive(),
  video: VideoSourceSchema,
  /** Free preview: playable on the public course page. */
  preview: z.boolean().default(false),
  /** Poster frame (data URL) captured from an uploaded video. */
  thumbnail: z.string().optional(),
});
export type Lesson = z.infer<typeof LessonSchema>;

export const SectionSchema = z.object({
  id: z.string(),
  title: LocalizedSchema,
  lessons: z.array(LessonSchema).min(1),
});
export type Section = z.infer<typeof SectionSchema>;

export const QuizQuestionSchema = z.object({
  id: z.string(),
  q: LocalizedSchema,
  options: z.array(LocalizedSchema).length(4),
  answer: z.number().int().min(0).max(3),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const CourseStatusSchema = z.enum(["draft", "published", "archived"]);
export type CourseStatus = z.infer<typeof CourseStatusSchema>;

export const CourseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: LocalizedSchema,
  subtitle: LocalizedSchema,
  description: LocalizedSchema,
  category: z.string(),
  instructorId: z.string(),
  level: LevelSchema,
  language: z.enum(["en", "ar"]),
  price: z.number().nonnegative(),
  originalPrice: z.number().nonnegative().optional(),
  rating: z.number().min(0).max(5),
  ratingCount: z.number().int().nonnegative(),
  students: z.number().int().nonnegative(),
  durationSec: z.number().int().positive(),
  updatedAt: z.string(),
  thumbnail: z.string(),
  previewVideo: VideoSourceSchema,
  outcomes: z.array(LocalizedSchema).min(1),
  requirements: z.array(LocalizedSchema),
  tags: z.array(z.string()),
  /** Credit for the embedded YouTube content. */
  credit: z.object({ channel: z.string() }),
  featured: z.boolean().default(false),
  bestseller: z.boolean().default(false),
  sections: z.array(SectionSchema).min(1),
  /** Only published courses are visible in the catalog. */
  status: CourseStatusSchema.default("published"),
  deletedAt: z.string().optional(),
  /** Instructor-written quiz; when absent the category quiz bank is used. */
  quiz: z.array(QuizQuestionSchema).optional(),
});
export type Course = z.infer<typeof CourseSchema>;

export const ReviewSchema = z.object({
  id: z.string(),
  courseId: z.string(),
  author: LocalizedSchema,
  rating: z.number().int().min(1).max(5),
  comment: LocalizedSchema,
  date: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const RoadmapSchema = z.object({
  slug: z.string(),
  title: LocalizedSchema,
  description: LocalizedSchema,
  level: LevelSchema,
  icon: z.string(),
  /** Ordered course slugs. */
  courses: z.array(z.string()).min(2),
});
export type Roadmap = z.infer<typeof RoadmapSchema>;

export const TestimonialSchema = z.object({
  id: z.string(),
  name: LocalizedSchema,
  role: LocalizedSchema,
  quote: LocalizedSchema,
});
export type Testimonial = z.infer<typeof TestimonialSchema>;
