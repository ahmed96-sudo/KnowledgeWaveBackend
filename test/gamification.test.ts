// DB-free: the XP, level, streak and badge rules (BACKEND_SPEC §6.3 / the frontend's gamification.ts).
import { describe, expect, it } from "vitest";
import { BADGES, XP, activeDays, bestStreak, levelFromXp, utcDay, xpForLevel, type Snapshot } from "../src/learning/gamification.js";
import { texts } from "../src/learning/notify.js";

describe("XP and levels", () => {
  it("awards the amounts of the spec", () => {
    expect(XP).toEqual({ lesson: 20, courseComplete: 150, quizPass: 50, quizPerfectBonus: 25, quizRetry: 5, review: 15 });
  });

  it("level n starts at 50·n·(n−1) XP: 0, 100, 300, 600, 1000, 1500", () => {
    expect([1, 2, 3, 4, 5, 6].map(xpForLevel)).toEqual([0, 100, 300, 600, 1000, 1500]);
    for (const [xp, level] of [[0, 1], [99, 1], [100, 2], [299, 2], [300, 3], [599, 3], [600, 4], [999, 4], [1000, 5], [1499, 5], [1500, 6]] as const) {
      expect(levelFromXp(xp), `${xp} XP`).toBe(level);
    }
  });
});

describe("streaks", () => {
  const d = (...days: string[]) => new Set(days);

  it("best streak is the longest run of consecutive days", () => {
    expect(bestStreak(d())).toBe(0);
    expect(bestStreak(d("2026-03-01"))).toBe(1);
    expect(bestStreak(d("2026-03-01", "2026-03-02", "2026-03-03", "2026-03-10", "2026-03-11"))).toBe(3);
    expect(bestStreak(d("2026-02-27", "2026-02-28", "2026-03-01"))).toBe(3); // across a month boundary
    expect(bestStreak(d("2026-12-31", "2027-01-01"))).toBe(2); // across a year boundary
  });

  it("a day is active with 30+ seconds of watching, or with any XP event", () => {
    const days = activeDays({ "2026-03-01": 29, "2026-03-02": 30, "2026-03-03": 500 }, [new Date("2026-03-05T23:59:00Z")]);
    expect([...days].sort()).toEqual(["2026-03-02", "2026-03-03", "2026-03-05"]);
    expect(utcDay("2026-03-05T23:59:00Z")).toBe("2026-03-05");
  });
});

describe("badges", () => {
  const none: Snapshot = { lessonsDone: 0, certificates: 0, enrollments: 0, reviews: 0, perfectQuiz: false, bestStreak: 0, level: 1 };
  const earned = (s: Partial<Snapshot>) => BADGES.filter((b) => b.test({ ...none, ...s })).map((b) => b.id);

  it("nothing is earned from nothing", () => expect(earned({})).toEqual([]));

  it("each badge has exactly the condition of the spec", () => {
    expect(earned({ lessonsDone: 1 })).toEqual(["first-lesson"]);
    expect(earned({ certificates: 1 })).toEqual(["first-course"]);
    expect(earned({ bestStreak: 3 })).toEqual(["streak-3"]);
    expect(earned({ bestStreak: 7 })).toEqual(["streak-3", "streak-7"]);
    expect(earned({ perfectQuiz: true })).toEqual(["quiz-ace"]);
    expect(earned({ reviews: 1 })).toEqual(["reviewer"]);
    expect(earned({ enrollments: 2 })).toEqual([]);
    expect(earned({ enrollments: 3 })).toEqual(["collector"]);
    expect(earned({ lessonsDone: 9 })).toEqual(["first-lesson"]);
    expect(earned({ lessonsDone: 10 })).toEqual(["first-lesson", "marathon"]);
    expect(earned({ level: 4 })).toEqual([]);
    expect(earned({ level: 5 })).toEqual(["level-5"]);
  });

  it("the nine badge ids are the ones the frontend knows", () => {
    expect(BADGES.map((b) => b.id)).toEqual(["first-lesson", "first-course", "streak-3", "streak-7", "quiz-ace", "reviewer", "collector", "marathon", "level-5"]);
  });
});

describe("notification texts", () => {
  it("are bilingual and match the spec", () => {
    const t = { en: "React", ar: "ريأكت" };
    expect(texts.enrolled(t)).toEqual({ title: { en: "You are enrolled!", ar: "تم تسجيلك في الدورة!" }, body: { en: "Start learning “React”.", ar: "ابدأ تعلّم «ريأكت»." } });
    expect(texts.certificate(t).body).toEqual({ en: "You completed “React”.", ar: "أتممت دورة «ريأكت»." });
    expect(texts.order("KW-1").body).toEqual({ en: "Order KW-1 is complete.", ar: "تم إكمال الطلب KW-1." });
    expect(texts.badge({ en: "First step", ar: "الخطوة الأولى" }).body).toEqual({ en: "You earned “First step”.", ar: "حصلت على «الخطوة الأولى»." });
    expect(texts.levelUp(3).title).toEqual({ en: "Level 3 reached!", ar: "وصلت إلى المستوى 3!" });
  });
});
