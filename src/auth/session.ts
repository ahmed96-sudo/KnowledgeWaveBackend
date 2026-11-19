import { randomBytes } from "node:crypto";
import type { CookieOptions, RequestHandler, Response } from "express";
import { config } from "../config.js";
import type { User } from "../generated/prisma/client.js";
import { sha256 } from "../lib/hash.js";
import { prisma } from "../lib/prisma.js";

/**
 * Server-side sessions. The cookie holds a random id; the `sessions` table holds only its SHA-256 hash, the user, and
 * the optional acting-as target. Logging out (or banning, deleting, changing the password) deletes rows, which takes
 * effect on the very next request. This is why we do not use JWTs.
 */

export type Auth = {
  /** Raw cookie value (never stored). */
  sid: string;
  /** Who is really signed in. */
  realUser: User;
  /** Who the request acts as: the real user, or the account an admin is acting as. */
  effectiveUser: User;
  acting: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Auth;
    }
  }
}

const TTL_MS = config.SESSION_TTL_DAYS * 86_400_000;
const EXTEND_AFTER_MS = 3_600_000; // rolling expiry is renewed at most once an hour, not on every request

/** Readable, non-sensitive hints for the frontend's Next proxy (UX redirects only, never trusted by the API). */
const HINT_ROLE = "kw_session";
const HINT_ACTOR = "kw_actor";

const cookieBase: CookieOptions = { sameSite: "lax", secure: config.isProd, path: "/" };

export async function createSession(userId: string) {
  const sid = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { id: sha256(sid), userId, expiresAt: new Date(Date.now() + TTL_MS) } });
  return sid;
}

export const destroySession = (sid: string) => prisma.session.deleteMany({ where: { id: sha256(sid) } });

/** Deletes every session of a user, optionally keeping the current one. */
export const destroyUserSessions = (userId: string, exceptSid?: string) =>
  prisma.session.deleteMany({ where: { userId, ...(exceptSid ? { id: { not: sha256(exceptSid) } } : {}) } });

export function setHintCookies(res: Response, effectiveUser: User, acting: boolean) {
  res.cookie(HINT_ROLE, effectiveUser.role, { ...cookieBase, maxAge: TTL_MS });
  if (acting) res.cookie(HINT_ACTOR, "admin", { ...cookieBase, maxAge: TTL_MS });
  else res.clearCookie(HINT_ACTOR, cookieBase);
}

export function setSessionCookies(res: Response, sid: string, effectiveUser: User, acting: boolean) {
  res.cookie(config.SESSION_COOKIE_NAME, sid, { ...cookieBase, httpOnly: true, maxAge: TTL_MS });
  setHintCookies(res, effectiveUser, acting);
}

export function clearSessionCookies(res: Response) {
  for (const name of [config.SESSION_COOKIE_NAME, HINT_ROLE, HINT_ACTOR]) res.clearCookie(name, cookieBase);
}

/**
 * Attaches `req.auth` when the request carries a live session. It never rejects: `requireAuth` decides what a
 * missing, banned or deleted user means for each route.
 */
export const loadSession: RequestHandler = async (req, res, next) => {
  const sid: unknown = req.cookies?.[config.SESSION_COOKIE_NAME];
  if (typeof sid !== "string" || !sid) return next();

  const row = await prisma.session.findUnique({ where: { id: sha256(sid) }, include: { user: true } });
  if (!row || row.expiresAt.getTime() <= Date.now()) return next();

  let effectiveUser = row.user;
  let acting = false;
  if (row.actingAsUserId) {
    const target = await prisma.user.findUnique({ where: { id: row.actingAsUserId } });
    if (target && !target.deletedAt && !target.bannedAt) {
      effectiveUser = target;
      acting = true;
    } else {
      // the account being impersonated was deleted or banned: fall back to the real admin
      await prisma.session.update({ where: { id: row.id }, data: { actingAsUserId: null } });
    }
  }

  if (row.expiresAt.getTime() - Date.now() < TTL_MS - EXTEND_AFTER_MS) {
    await prisma.session.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() + TTL_MS) } });
    setSessionCookies(res, sid, effectiveUser, acting);
  }

  req.auth = { sid, realUser: row.user, effectiveUser, acting };
  next();
};
