// Appendix A of BACKEND_SPEC.md (from the frontend's src/lib/schemas/learning.ts). `PasswordChangeSchema` is left out:
// the API body is just { current, next }.
import { z } from "zod";
import { LocalizedSchema } from "./common.js";

export const ProgressEntrySchema = z.object({
  completed: z.boolean(),
  positionSec: z.number().nonnegative(),
  completedAt: z.string().optional(),
});

export const NoteSchema = z.object({
  id: z.string(),
  courseSlug: z.string(),
  lessonId: z.string(),
  atSec: z.number().nonnegative(),
  text: z.string().min(1),
  createdAt: z.string(),
});
export type Note = z.infer<typeof NoteSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  items: z.array(z.object({ slug: z.string(), title: LocalizedSchema, price: z.number().nonnegative() })),
  subtotal: z.number().nonnegative(),
  discount: z.number().nonnegative(),
  total: z.number().nonnegative(),
  coupon: z.string().optional(),
  cardBrand: z.string(),
  cardLast4: z.string(),
  status: z.enum(["paid", "refunded"]),
});
export type Order = z.infer<typeof OrderSchema>;

export const XpEventSchema = z.object({
  id: z.string(),
  type: z.enum(["lesson", "quiz", "course", "review", "streak"]),
  amount: z.number().int(),
  at: z.string(),
  refId: z.string().optional(),
});
export type XpEvent = z.infer<typeof XpEventSchema>;

export const QuizAttemptSchema = z.object({
  id: z.string(),
  courseSlug: z.string(),
  score: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  passed: z.boolean(),
  at: z.string(),
  durationSec: z.number().nonnegative(),
  answers: z.array(z.number().int()),
});
export type QuizAttempt = z.infer<typeof QuizAttemptSchema>;

export const ReviewEntrySchema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string(), date: z.string() });
export type ReviewEntry = z.infer<typeof ReviewEntrySchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  kind: z.enum(["xp", "badge", "order", "certificate", "course", "system"]),
  title: LocalizedSchema,
  body: LocalizedSchema,
  at: z.string(),
  read: z.boolean(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const CertificateSchema = z.object({ id: z.string(), courseSlug: z.string(), issuedAt: z.string() });
export type Certificate = z.infer<typeof CertificateSchema>;

export const SettingsSchema = z.object({
  weeklyGoal: z.number().int().min(1).max(30),
  emailNotifications: z.boolean(),
  productUpdates: z.boolean(),
  autoplayNext: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Everything the backend stores for one learner (GET /me/learning). */
export const UserDataSchema = z.object({
  enrollments: z.array(z.object({ slug: z.string(), at: z.string() })),
  progress: z.record(z.string(), ProgressEntrySchema),
  lastLesson: z.record(z.string(), z.string()),
  notes: z.array(NoteSchema),
  wishlist: z.array(z.string()),
  orders: z.array(OrderSchema),
  reviews: z.record(z.string(), ReviewEntrySchema),
  quizAttempts: z.array(QuizAttemptSchema),
  xpEvents: z.array(XpEventSchema),
  badges: z.record(z.string(), z.string()),
  notifications: z.array(NotificationSchema),
  certificates: z.array(CertificateSchema),
  /** Seconds of learning per local day (YYYY-MM-DD). */
  activity: z.record(z.string(), z.number().nonnegative()),
  settings: SettingsSchema,
  bio: z.string(),
});
export type UserData = z.infer<typeof UserDataSchema>;

export const QaReplySchema = z.object({ id: z.string(), author: z.string(), role: z.enum(["student", "instructor", "admin"]), text: z.string(), at: z.string() });
export const QaThreadSchema = z.object({
  id: z.string(),
  courseSlug: z.string(),
  lessonId: z.string(),
  author: z.string(),
  text: z.string(),
  at: z.string(),
  replies: z.array(QaReplySchema),
  resolved: z.boolean().optional(),
});
export type QaThread = z.infer<typeof QaThreadSchema>;

export const ProfileSchema = z.object({
  name: z.string().min(2, { message: "nameShort" }),
  bio: z.string().max(240, { message: "bioLong" }),
  weeklyGoal: z.number().int().min(1).max(30),
});
export type ProfileInput = z.infer<typeof ProfileSchema>;

export const ReviewInputSchema = z.object({
  rating: z.number().int().min(1, { message: "ratingRequired" }).max(5),
  comment: z.string().max(400, { message: "commentLong" }),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
