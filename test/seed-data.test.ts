// DB-free: the seed JSON must satisfy the contract schemas and reference each other correctly.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CategorySchema, CourseSchema, InstructorSchema, QuizQuestionSchema, ReviewSchema, RoadmapSchema, TestimonialSchema } from "../src/schemas/course.js";
import { QaThreadSchema } from "../src/schemas/learning.js";
import { UserSchema } from "../src/schemas/user.js";

const read = <T extends z.ZodType>(file: string, schema: T) =>
  schema.parse(JSON.parse(readFileSync(new URL(`../seed/${file}`, import.meta.url), "utf8"))) as z.infer<T>;

const categories = read("categories.json", z.array(CategorySchema));
const instructors = read("instructors.json", z.array(InstructorSchema));
const courses = read("courses.json", z.array(CourseSchema));
const quizBank = read("quizzes.json", z.record(z.string(), z.array(QuizQuestionSchema)));
const reviews = read("reviews.json", z.array(ReviewSchema));
const roadmaps = read("roadmaps.json", z.array(RoadmapSchema));
const testimonials = read("testimonials.json", z.array(TestimonialSchema));
const threads = read("qa.json", z.array(QaThreadSchema));
const users = read("demo-users.json", z.array(UserSchema));

describe("seed data", () => {
  it("has the row counts the spec lists", () => {
    expect([categories.length, instructors.length, courses.length, reviews.length, roadmaps.length, testimonials.length, threads.length, users.length]).toEqual([
      8, 12, 26, 104, 6, 3, 26, 3,
    ]);
    expect(Object.keys(quizBank)).toHaveLength(8);
    expect(Object.values(quizBank).every((q) => q.length === 4)).toBe(true);
  });

  it("courses reference existing categories and instructors; ids are unique", () => {
    const cats = new Set(categories.map((c) => c.slug)), ins = new Set(instructors.map((i) => i.id));
    expect(courses.every((c) => cats.has(c.category) && ins.has(c.instructorId))).toBe(true);
    const lessonIds = courses.flatMap((c) => c.sections.flatMap((s) => s.lessons.map((l) => l.id)));
    expect(new Set(lessonIds).size).toBe(lessonIds.length);
    expect(new Set(courses.map((c) => c.slug)).size).toBe(courses.length);
  });

  it("instructors.courses equals their real course count (frontend test requires it)", () => {
    for (const i of instructors) expect(i.courses, i.id).toBe(courses.filter((c) => c.instructorId === i.id).length);
  });

  it("reviews, roadmaps, Q&A and quiz bank point at things that exist", () => {
    const ids = new Set(courses.map((c) => c.id)), slugs = new Set(courses.map((c) => c.slug)), cats = new Set(categories.map((c) => c.slug));
    expect(reviews.every((r) => ids.has(r.courseId))).toBe(true);
    expect(roadmaps.every((r) => r.courses.every((s) => slugs.has(s)))).toBe(true);
    expect(Object.keys(quizBank).every((k) => cats.has(k))).toBe(true);
    const lessonsBySlug = new Map(courses.map((c) => [c.slug, new Set(c.sections.flatMap((s) => s.lessons.map((l) => l.id)))]));
    expect(threads.every((t) => lessonsBySlug.get(t.courseSlug)?.has(t.lessonId))).toBe(true);
  });

  it("demo instructor account links to a seeded instructor", () => {
    const u = users.find((x) => x.role === "instructor");
    expect(instructors.some((i) => i.id === u?.instructorId)).toBe(true);
  });
});
