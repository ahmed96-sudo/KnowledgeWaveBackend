import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";

/**
 * Per-IP limiter returning our standard error (`tooManyRequests`, 429).
 * ponytail: in-memory counters, per process and reset on restart. Use a shared store (Redis/Postgres) if you run
 * several instances. Behind a reverse proxy also set TRUST_PROXY, or every user shares one bucket.
 * Disabled under NODE_ENV=test unless `skipInTest: false`.
 */
export const createLimiter = ({ windowMs, limit, skipInTest = true }: { windowMs: number; limit: number; skipInTest?: boolean }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => config.isTest && skipInTest,
    handler: (_req, _res, next) => next(new ApiError("tooManyRequests", "Too many requests, please try again later")),
  });
