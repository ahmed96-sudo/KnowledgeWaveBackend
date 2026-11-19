import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { Prisma, type User } from "../generated/prisma/client.js";
import { ApiError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { sendMail } from "../lib/mail.js";
import { prisma } from "../lib/prisma.js";
import { uniqueSlug } from "../lib/slug.js";
import type { RegisterInput } from "../schemas/user.js";
import { burnPasswordCheck, hashPassword, verifyPassword } from "./password.js";
import { destroyUserSessions } from "./session.js";

export const RESET_TOKEN_TTL_MS = 10 * 60_000;

const normEmail = (email: string) => email.trim().toLowerCase();

/** The public `User` shape. Never includes passwordHash, bannedAt or deletedAt. */
export const toUser = (u: User) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  ...(u.instructorId ? { instructorId: u.instructorId } : {}),
});

export async function register(input: RegisterInput) {
  const email = normEmail(input.email);
  const name = input.name.trim();
  if (await prisma.user.findUnique({ where: { email } })) throw new ApiError("emailTaken", "This email is already registered");
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.$transaction(async (tx) => {
      let instructorId: string | null = null;
      if (input.role === "instructor") {
        // an instructor account also gets its public profile
        instructorId = await uniqueSlug(name, async (id) => !!(await tx.instructor.findUnique({ where: { id } })), "instructor");
        await tx.instructor.create({
          data: {
            id: instructorId,
            name: { en: name, ar: name },
            headline: { en: "Instructor", ar: "مدرّب" },
            bio: { en: "Instructor on KnowledgeWave.", ar: "مدرّب على KnowledgeWave." },
          },
        });
      }
      return tx.user.create({
        data: { id: `u-${randomUUID()}`, name, email, passwordHash, role: input.role, instructorId, settings: { create: {} } },
      });
    });
  } catch (e) {
    // two simultaneous registrations with the same email: the loser hits the unique constraint
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && (await prisma.user.findUnique({ where: { email } }))) {
      throw new ApiError("emailTaken", "This email is already registered");
    }
    throw e;
  }
}

export async function login(emailRaw: string, password: string) {
  const user = await prisma.user.findFirst({ where: { email: normEmail(emailRaw), deletedAt: null } });
  if (!user) {
    await burnPasswordCheck(password); // same response time as a wrong password
    throw new ApiError("invalidCredentials", "Wrong email or password");
  }
  if (!(await verifyPassword(user.passwordHash, password))) throw new ApiError("invalidCredentials", "Wrong email or password");
  // checked after the password, so the suspended state is not revealed to someone who does not know it
  if (user.bannedAt) throw new ApiError("banned", "This account has been suspended");
  return user;
}

/** Changes `user`'s password and signs out all their other sessions (`keepSid` stays signed in). */
export async function changePassword(user: User, current: string, next: string, keepSid: string) {
  if (!(await verifyPassword(user.passwordHash, current))) throw new ApiError("invalidCredentials", "Current password is wrong");
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } });
  await destroyUserSessions(user.id, keepSid);
}

/** Emails a reset link when the account exists. Callers answer 204 first, so timing never reveals whether it did. */
export async function requestPasswordReset(emailRaw: string) {
  const user = await prisma.user.findFirst({ where: { email: normEmail(emailRaw), deletedAt: null, bannedAt: null } });
  if (!user) return;
  const token = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }), // only the newest link works
    prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) } }),
  ]);
  const link = `${config.FRONTEND_URL}/reset-password?token=${token}`;
  await sendMail({
    to: user.email,
    subject: "Reset your KnowledgeWave password | إعادة تعيين كلمة المرور",
    text: [
      "Someone asked to reset the password of your KnowledgeWave account.",
      `Open this link within 10 minutes to choose a new one:\n${link}`,
      "If it was not you, ignore this email: your password stays the same.",
      "",
      "طلب أحدهم إعادة تعيين كلمة مرور حسابك في KnowledgeWave.",
      `افتح الرابط التالي خلال 10 دقائق لاختيار كلمة مرور جديدة:\n${link}`,
      "إذا لم تكن أنت، تجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.",
    ].join("\n\n"),
    html: `<p>Someone asked to reset the password of your KnowledgeWave account.</p>
<p><a href="${link}">Choose a new password</a> (valid for 10 minutes). If it was not you, ignore this email.</p>
<hr><div dir="rtl"><p>طلب أحدهم إعادة تعيين كلمة مرور حسابك في KnowledgeWave.</p>
<p><a href="${link}">اختر كلمة مرور جديدة</a> (صالح لمدة 10 دقائق). إذا لم تكن أنت، تجاهل هذه الرسالة.</p></div>`,
  });
}

export async function resetPassword(token: string, next: string) {
  const invalid = () => new ApiError("invalid", "This reset link is invalid or has expired");
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) throw invalid();
  const passwordHash = await hashPassword(next);
  await prisma.$transaction(async (tx) => {
    // claim the token atomically: two simultaneous requests cannot both use it
    const claimed = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw invalid();
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: row.userId } });
  });
}
