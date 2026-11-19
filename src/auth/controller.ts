import type { Request, Response } from "express";
import { config } from "../config.js";
import { auth } from "../middleware/auth.js";
import type { ForgotInput, LoginInput, RegisterInput } from "../schemas/user.js";
import * as service from "./service.js";
import { clearSessionCookies, createSession, destroySession, setHintCookies, setSessionCookies } from "./session.js";

export async function register(req: Request, res: Response) {
  const user = await service.register(req.body as RegisterInput);
  setSessionCookies(res, await createSession(user.id), user, false);
  res.status(201).json(service.toUser(user));
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as LoginInput;
  const user = await service.login(email, password);
  setSessionCookies(res, await createSession(user.id), user, false);
  res.json(service.toUser(user));
}

export async function logout(req: Request, res: Response) {
  const sid: unknown = req.cookies?.[config.SESSION_COOKIE_NAME];
  if (typeof sid === "string" && sid) await destroySession(sid);
  clearSessionCookies(res);
  res.status(204).end();
}

export function me(req: Request, res: Response) {
  const a = auth(req);
  setHintCookies(res, a.effectiveUser, a.acting); // keeps the frontend's hint cookies in step with role changes
  res.json({ status: "ok", user: service.toUser(a.effectiveUser), realUser: a.acting ? service.toUser(a.realUser) : null });
}

export async function changePassword(req: Request, res: Response) {
  const { current, next } = req.body as { current: string; next: string };
  const a = auth(req);
  // always the REAL user's password, even while acting as someone else (never the impersonated account's)
  await service.changePassword(a.realUser, current, next, a.sid);
  res.status(204).end();
}

export async function forgotPassword(req: Request, res: Response) {
  res.status(204).end(); // answer first: whether the email exists must not show in the response or its timing
  await service.requestPasswordReset((req.body as ForgotInput).email).catch((e) => console.error("forgot-password failed", e));
}

export async function resetPassword(req: Request, res: Response) {
  const { token, next } = req.body as { token: string; next: string };
  await service.resetPassword(token, next);
  res.status(204).end();
}
