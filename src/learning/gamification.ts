// The frontend's src/lib/learning/gamification.ts rules (the frontend wins: keep them identical), as pure functions.
import type { Localized } from "../lib/localized.js";

export const XP = { lesson: 20, courseComplete: 150, quizPass: 50, quizPerfectBonus: 25, quizRetry: 5, review: 15 } as const;
export const PASS_MARK = 0.7;

/** Level n starts at 50·n·(n−1) XP: 0, 100, 300, 600, 1000… */
export const xpForLevel = (level: number) => 50 * level * (level - 1);
export const levelFromXp = (xp: number) => Math.max(1, Math.floor((1 + Math.sqrt(1 + xp / 12.5)) / 2));

/** ponytail: days are UTC because the server does not know the learner's timezone (only affects streak badges near midnight). */
export const utcDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const nextDay = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDay(d);
};

/** A day counts as active when the learner watched 30+ seconds or earned any XP that day. */
export function activeDays(activity: Record<string, number>, xpEventDates: Date[]): Set<string> {
  const days = new Set<string>();
  for (const [day, sec] of Object.entries(activity)) if (sec >= 30) days.add(day);
  for (const at of xpEventDates) days.add(utcDay(at));
  return days;
}

/** Longest run of consecutive active days. */
export function bestStreak(days: Set<string>): number {
  let best = 0, run = 0, prev: string | null = null;
  for (const d of [...days].sort()) {
    run = prev && nextDay(prev) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

export type Snapshot = { lessonsDone: number; certificates: number; enrollments: number; reviews: number; perfectQuiz: boolean; bestStreak: number; level: number };

export const BADGES: { id: string; name: Localized; test: (s: Snapshot) => boolean }[] = [
  { id: "first-lesson", name: { en: "First step", ar: "الخطوة الأولى" }, test: (s) => s.lessonsDone >= 1 },
  { id: "first-course", name: { en: "Graduate", ar: "خريج" }, test: (s) => s.certificates >= 1 },
  { id: "streak-3", name: { en: "On a roll", ar: "في تقدم" }, test: (s) => s.bestStreak >= 3 },
  { id: "streak-7", name: { en: "Unstoppable", ar: "لا يُوقف" }, test: (s) => s.bestStreak >= 7 },
  { id: "quiz-ace", name: { en: "Quiz ace", ar: "بطل الاختبارات" }, test: (s) => s.perfectQuiz },
  { id: "reviewer", name: { en: "Helpful reviewer", ar: "مقيّم مفيد" }, test: (s) => s.reviews >= 1 },
  { id: "collector", name: { en: "Curious mind", ar: "عقل فضولي" }, test: (s) => s.enrollments >= 3 },
  { id: "marathon", name: { en: "Marathoner", ar: "عدّاء ماراثون" }, test: (s) => s.lessonsDone >= 10 },
  { id: "level-5", name: { en: "Level 5", ar: "المستوى 5" }, test: (s) => s.level >= 5 },
];
