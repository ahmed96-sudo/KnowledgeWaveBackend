import type { Tx } from "../lib/prisma.js";
import { fromCents } from "../lib/money.js";
import type { Localized } from "../lib/localized.js";
import type { UserData } from "../schemas/learning.js";

export const DEFAULT_SETTINGS = { weeklyGoal: 5, emailNotifications: true, productUpdates: false, autoplayNext: true };
const iso = (d: Date) => d.toISOString();

/** One learner's whole record (GET /me/learning), in the same orders the frontend's mock uses. */
export async function getUserData(db: Tx, userId: string): Promise<UserData> {
  const where = { userId };
  const [enrollments, progress, lastLessons, notes, wishlist, orders, reviews, attempts, xpEvents, badges, notifications, certificates, activity, settings] = await Promise.all([
    db.enrollment.findMany({ where, orderBy: { enrolledAt: "asc" } }),
    db.lessonProgress.findMany({ where }),
    db.lastLesson.findMany({ where }),
    db.note.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.wishlist.findMany({ where, orderBy: [{ addedAt: "asc" }, { courseSlug: "asc" }] }),
    db.order.findMany({ where, orderBy: { createdAt: "desc" }, include: { items: true } }),
    db.review.findMany({ where, include: { course: { select: { slug: true } } } }),
    db.quizAttempt.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }] }),
    db.xpEvent.findMany({ where, orderBy: [{ at: "asc" }, { id: "asc" }] }),
    db.badgeAwarded.findMany({ where }),
    db.notification.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }] }),
    db.certificate.findMany({ where, orderBy: { issuedAt: "asc" } }),
    db.activityDay.findMany({ where }),
    db.userSettings.findUnique({ where: { userId } }),
  ]);

  return {
    enrollments: enrollments.map((e) => ({ slug: e.courseSlug, at: iso(e.enrolledAt) })),
    progress: Object.fromEntries(
      progress.map((p) => [p.lessonId, { completed: p.completed, positionSec: p.positionSec, ...(p.completedAt ? { completedAt: iso(p.completedAt) } : {}) }]),
    ),
    lastLesson: Object.fromEntries(lastLessons.map((l) => [l.courseSlug, l.lessonId])),
    notes: notes.map((n) => ({ id: n.id, courseSlug: n.courseSlug, lessonId: n.lessonId, atSec: n.atSec, text: n.text, createdAt: iso(n.createdAt) })),
    wishlist: wishlist.map((w) => w.courseSlug),
    orders: orders.map((o) => ({
      id: o.id,
      createdAt: iso(o.createdAt),
      items: o.items.map((i) => ({ slug: i.courseSlug, title: i.title as Localized, price: fromCents(i.priceCents) })),
      subtotal: fromCents(o.subtotalCents),
      discount: fromCents(o.discountCents),
      total: fromCents(o.totalCents),
      ...(o.coupon ? { coupon: o.coupon } : {}),
      cardBrand: o.cardBrand,
      cardLast4: o.cardLast4,
      status: o.status,
    })),
    reviews: Object.fromEntries(
      reviews.map((r) => {
        const en = (r.comment as Localized).en;
        return [r.course.slug, { rating: r.rating, comment: en === "—" ? "" : en, date: r.date }]; // "—" stands for an empty comment
      }),
    ),
    quizAttempts: attempts.map((a) => ({ id: a.id, courseSlug: a.courseSlug, score: a.score, total: a.total, passed: a.passed, at: iso(a.at), durationSec: a.durationSec, answers: a.answers })),
    xpEvents: xpEvents.map((e) => ({ id: e.id, type: e.type, amount: e.amount, at: iso(e.at), ...(e.refId ? { refId: e.refId } : {}) })),
    badges: Object.fromEntries(badges.map((b) => [b.badgeId, iso(b.awardedAt)])),
    notifications: notifications.map((n) => ({ id: n.id, kind: n.kind, title: n.title as Localized, body: n.body as Localized, at: iso(n.at), read: n.read })),
    certificates: certificates.map((c) => ({ id: c.id, courseSlug: c.courseSlug, issuedAt: iso(c.issuedAt) })),
    activity: Object.fromEntries(activity.map((a) => [a.day, a.seconds])),
    settings: settings
      ? { weeklyGoal: settings.weeklyGoal, emailNotifications: settings.emailNotifications, productUpdates: settings.productUpdates, autoplayNext: settings.autoplayNext }
      : DEFAULT_SETTINGS,
    bio: settings?.bio ?? "",
  };
}
