import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../middleware/rate-limit.js";
import { validate } from "../middleware/validate.js";
import { ForgotSchema, LoginSchema, RegisterSchema } from "../schemas/user.js";
import * as c from "./controller.js";

const HOUR = 3_600_000;
const loginLimit = createLimiter({ windowMs: 15 * 60_000, limit: 10 });
const registerLimit = createLimiter({ windowMs: HOUR, limit: 10 });
const forgotLimit = createLimiter({ windowMs: HOUR, limit: 5 });
const resetLimit = createLimiter({ windowMs: HOUR, limit: 10 });

const password8 = z.string().min(8, { message: "passwordShort8" });
const ChangePasswordSchema = z.object({ current: z.string().min(1, { message: "required" }), next: password8 });
const ResetPasswordSchema = z.object({ token: z.string().min(1), next: password8 });

export const authRoutes = Router();

authRoutes.post("/register", registerLimit, validate({ body: RegisterSchema }), c.register);
authRoutes.post("/login", loginLimit, validate({ body: LoginSchema }), c.login);
authRoutes.post("/logout", c.logout);
authRoutes.get("/me", requireAuth, c.me);
authRoutes.post("/forgot-password", forgotLimit, validate({ body: ForgotSchema }), c.forgotPassword);
authRoutes.post("/reset-password", resetLimit, validate({ body: ResetPasswordSchema }), c.resetPassword);
authRoutes.post("/change-password", requireAuth, validate({ body: ChangePasswordSchema }), c.changePassword);
