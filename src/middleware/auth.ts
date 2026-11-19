import type { Request, RequestHandler } from "express";
import { clearSessionCookies, destroySession, type Auth } from "../auth/session.js";
import type { Role } from "../generated/prisma/client.js";
import { ApiError } from "../lib/errors.js";

/** The authenticated context of a request. Only call it behind `requireAuth` / `requireRole` / `requireRealAdmin`. */
export function auth(req: Request): Auth {
  if (!req.auth) throw new ApiError("unauthenticated", "Sign in required");
  return req.auth;
}

/**
 * 401 without a session. A banned or deleted real user is rejected on every protected request (and the session is
 * destroyed), not only on the next page load.
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const { sid, realUser } = auth(req);
  if (realUser.deletedAt || realUser.bannedAt) {
    await destroySession(sid);
    clearSessionCookies(res);
    throw realUser.deletedAt
      ? new ApiError("gone", "This account no longer exists")
      : new ApiError("banned", "This account has been suspended");
  }
  next();
};

/** The effective user (the account being acted as, if any) must have one of the roles, else 403. */
export const requireRole = (...roles: Role[]): RequestHandler[] => [
  requireAuth,
  (req, _res, next) => {
    if (!roles.includes(auth(req).effectiveUser.role)) throw new ApiError("forbidden", "You do not have access to this");
    next();
  },
];

/** Admin endpoints check the REAL user, so an admin who is acting as a student can still use /admin/*. */
export const requireRealAdmin: RequestHandler[] = [
  requireAuth,
  (req, _res, next) => {
    if (auth(req).realUser.role !== "admin") throw new ApiError("forbidden", "Admins only");
    next();
  },
];
