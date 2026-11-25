// Needs the test database for the seedBase tests; the guard test is DB-free.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/auth/password.js";
import { prisma } from "../src/lib/prisma.js";
import { BaseSeedEnvSchema, seedBase } from "../src/seed-base.js";
import { assertDemoSeedAllowed } from "../src/seed.js";
import { resetDb } from "./helpers/db.js";

describe("demo seed production guard", () => {
  it("refuses in production, allows everywhere else", () => {
    expect(() => assertDemoSeedAllowed("production")).toThrow(/Refusing to load demo data/);
    for (const env of ["development", "test"]) expect(() => assertDemoSeedAllowed(env)).not.toThrow();
  });
});

describe("base seed input", () => {
  it("needs a valid email and a 12+ character password", () => {
    expect(BaseSeedEnvSchema.safeParse({ ADMIN_EMAIL: "a@example.com", ADMIN_PASSWORD: "a-long-enough-password" }).success).toBe(true);
    expect(BaseSeedEnvSchema.safeParse({ ADMIN_EMAIL: "nope", ADMIN_PASSWORD: "a-long-enough-password" }).success).toBe(false);
    expect(BaseSeedEnvSchema.safeParse({ ADMIN_EMAIL: "a@example.com", ADMIN_PASSWORD: "short" }).success).toBe(false);
  });
});

describe("seedBase", () => {
  beforeEach(resetDb);
  afterAll(() => prisma.$disconnect());
  const input = { ADMIN_EMAIL: "Owner@Example.com", ADMIN_PASSWORD: "a-long-enough-password", ADMIN_NAME: "Owner" };

  it("creates only the admin account (hashed password, settings row), nothing else", async () => {
    expect(await seedBase(input)).toEqual({ created: true });
    const u = await prisma.user.findFirstOrThrow({ include: { settings: true } });
    expect([u.email, u.role, u.name]).toEqual(["owner@example.com", "admin", "Owner"]);
    expect(await verifyPassword(u.passwordHash, input.ADMIN_PASSWORD)).toBe(true);
    expect(u.settings).not.toBeNull();
    expect([await prisma.user.count(), await prisma.course.count(), await prisma.category.count(), await prisma.coupon.count()]).toEqual([1, 0, 0, 0]);
  });

  it("is create-only: a second run never resets the password or the name", async () => {
    await seedBase(input);
    await prisma.user.updateMany({ data: { name: "Renamed" } });
    expect(await seedBase({ ...input, ADMIN_PASSWORD: "a-different-password-123" })).toEqual({ created: false });
    const u = await prisma.user.findFirstOrThrow();
    expect(u.name).toBe("Renamed");
    expect(await verifyPassword(u.passwordHash, input.ADMIN_PASSWORD)).toBe(true);
  });
});
