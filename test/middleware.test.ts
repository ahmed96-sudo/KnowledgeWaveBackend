// DB-free: CSRF header, role guards, rate limiting and password hashing.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import type { User } from "../src/generated/prisma/client.js";
import { requireRealAdmin, requireRole } from "../src/middleware/auth.js";
import { csrf } from "../src/middleware/csrf.js";
import { errorHandler } from "../src/middleware/error.js";
import { createLimiter } from "../src/middleware/rate-limit.js";

const fakeUser = (role: string) => ({ id: `u-${role}`, role, deletedAt: null, bannedAt: null }) as unknown as User;

/** Headers x-real-role / x-effective-role fake a signed-in session (no database involved). */
function appWith(mount: (a: express.Express) => void) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    const real = req.get("x-real-role");
    if (real) {
      const eff = req.get("x-effective-role") ?? real;
      req.auth = { sid: "sid", realUser: fakeUser(real), effectiveUser: fakeUser(eff), acting: eff !== real };
    }
    next();
  });
  mount(a);
  a.use(errorHandler);
  return a;
}

describe("csrf", () => {
  const a = appWith((x) => {
    x.use(csrf);
    x.all("/x", (_req, res) => void res.json({ ok: true }));
  });

  it("rejects state-changing requests without X-Requested-With: fetch", async () => {
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const res = await request(a)[method]("/x");
      expect(res.status, method).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
  });

  it("allows them with the header, and GET without it", async () => {
    expect((await request(a).post("/x").set("X-Requested-With", "fetch")).status).toBe(200);
    expect((await request(a).get("/x")).status).toBe(200);
  });

  describe("Origin", () => {
    const post = (origin?: string) => {
      const r = request(a).post("/x").set("X-Requested-With", "fetch");
      return origin === undefined ? r : r.set("Origin", origin);
    };

    it("accepts our frontend origin, and requests with no Origin (curl, server-to-server)", async () => {
      expect((await post(config.CORS_ORIGIN)).status).toBe(200);
      expect((await post()).status).toBe(200);
    });

    it("refuses any other origin, even with the custom header", async () => {
      for (const origin of ["https://evil.example", "null", `${config.CORS_ORIGIN}.evil.example`, "http://localhost:3001"]) {
        const res = await post(origin);
        expect([res.status, res.body.error.code], origin).toEqual([403, "forbidden"]);
      }
    });

    it("does not look at Origin on reads", async () => {
      expect((await request(a).get("/x").set("Origin", "https://evil.example")).status).toBe(200);
    });
  });
});

describe("role guards", () => {
  const a = appWith((x) => {
    x.get("/instructor", requireRole("instructor", "admin"), (_req: express.Request, res: express.Response) => void res.json({ ok: true }));
    x.get("/admin", requireRealAdmin, (_req: express.Request, res: express.Response) => void res.json({ ok: true }));
  });

  it("401 unauthenticated without a session", async () => {
    const res = await request(a).get("/instructor");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("403 forbidden for the wrong role, 200 for an allowed one", async () => {
    expect((await request(a).get("/instructor").set("x-real-role", "student")).status).toBe(403);
    expect((await request(a).get("/instructor").set("x-real-role", "instructor")).status).toBe(200);
    expect((await request(a).get("/instructor").set("x-real-role", "admin")).status).toBe(200);
  });

  it("admin endpoints look at the REAL user: an admin acting as a student still gets in", async () => {
    expect((await request(a).get("/admin").set("x-real-role", "admin").set("x-effective-role", "student")).status).toBe(200);
    expect((await request(a).get("/admin").set("x-real-role", "student")).status).toBe(403);
    expect((await request(a).get("/admin")).status).toBe(401);
  });

  it("student endpoints use the EFFECTIVE user while acting", async () => {
    const res = await request(a).get("/instructor").set("x-real-role", "admin").set("x-effective-role", "student");
    expect(res.status).toBe(403);
  });
});

describe("rate limit", () => {
  it("answers 429 tooManyRequests in the standard error shape after the limit", async () => {
    const a = appWith((x) => {
      x.get("/x", createLimiter({ windowMs: 60_000, limit: 2, skipInTest: false }), (_req, res) => void res.json({ ok: true }));
    });
    expect((await request(a).get("/x")).status).toBe(200);
    expect((await request(a).get("/x")).status).toBe(200);
    const res = await request(a).get("/x");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("tooManyRequests");
  });
});

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "correct horse")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    await expect(burnPasswordCheck("anything")).resolves.toBeUndefined();
  });
});
