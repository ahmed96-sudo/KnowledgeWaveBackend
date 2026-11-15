import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/lib/errors.js";
import { errorHandler } from "../src/middleware/error.js";
import { validate } from "../src/middleware/validate.js";

const app = createApp();

describe("skeleton", () => {
  it("GET /api/health", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("there is no /api/v1 prefix", async () => {
    expect((await request(app).get("/api/v1/health")).status).toBe(404);
  });

  it("unknown route returns the standard error shape", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "notFound", message: "Route not found: GET /api/nope", details: [] } });
  });

  it("malformed JSON is a validation error", async () => {
    const res = await request(app).post("/api/health").set("Content-Type", "application/json").send("{oops");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation");
  });

  it("CORS allows the frontend origin with credentials", async () => {
    const res = await request(app).get("/api/health").set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

describe("validate + errors", () => {
  const t = express();
  t.use(express.json());
  t.post(
    "/body",
    validate({ body: z.object({ name: z.string().min(2, "nameShort"), n: z.coerce.number().default(7) }) }),
    (req, res) => void res.json(req.body),
  );
  t.get("/q", validate({ query: z.object({ page: z.coerce.number().int().default(1) }) }), (req, res) => void res.json(req.query));
  t.get("/boom", () => {
    throw new ApiError("forbidden", "nope");
  });
  t.get("/crash", () => {
    throw new Error("secret internals");
  });
  t.use(errorHandler);

  it("coerces and defaults a valid body", async () => {
    expect((await request(t).post("/body").send({ name: "Amira" })).body).toEqual({ name: "Amira", n: 7 });
  });

  it("invalid body: 422 validation with { path, message } details", async () => {
    const res = await request(t).post("/body").send({ name: "A" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "validation", details: [{ path: "name", message: "nameShort" }] });
  });

  it("query values are replaced by the parsed ones", async () => {
    expect((await request(t).get("/q?page=3")).body).toEqual({ page: 3 });
    expect((await request(t).get("/q")).body).toEqual({ page: 1 });
  });

  it("ApiError maps code to status; unknown errors do not leak", async () => {
    expect((await request(t).get("/boom")).status).toBe(403);
    const res = await request(t).get("/crash");
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: "internal", message: "Internal server error", details: [] });
  });
});
