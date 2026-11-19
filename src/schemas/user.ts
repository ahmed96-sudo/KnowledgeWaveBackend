// Appendix A of BACKEND_SPEC.md (from the frontend's src/lib/schemas/user.ts). The mock-only `AccountSchema`
// (clear-text password) is left out: the real account is the Prisma `User` model.
import { z } from "zod";
import { RoleSchema } from "./common.js";

export const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.email(),
  role: RoleSchema,
  /** Links an instructor account to its public instructor profile. */
  instructorId: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const LoginSchema = z.object({
  email: z.email({ message: "invalidEmail" }),
  password: z.string().min(6, { message: "passwordShort" }),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RegisterSchema = z.object({
  name: z.string().min(2, { message: "nameShort" }),
  email: z.email({ message: "invalidEmail" }),
  password: z.string().min(8, { message: "passwordShort8" }),
  role: z.enum(["student", "instructor"]),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const ForgotSchema = z.object({ email: z.email({ message: "invalidEmail" }) });
export type ForgotInput = z.infer<typeof ForgotSchema>;

export const ContactSchema = z.object({
  name: z.string().min(2, { message: "nameShort" }),
  email: z.email({ message: "invalidEmail" }),
  message: z.string().min(10, { message: "messageShort" }),
});
export type ContactInput = z.infer<typeof ContactSchema>;
