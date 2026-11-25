import type { Request } from "express";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

/** Who is asking, for visibility decisions. null = guest (also used for a banned or deleted account). */
export type Viewer = { userId: string; instructorId: string | null; isAdmin: boolean } | null;

export function viewerOf(req: Request): Viewer {
  const a = req.auth;
  if (!a || a.realUser.bannedAt || a.realUser.deletedAt) return null;
  return {
    userId: a.effectiveUser.id,
    instructorId: a.effectiveUser.instructorId,
    isAdmin: a.effectiveUser.role === "admin" || a.realUser.role === "admin", // real OR acting admin
  };
}

/** A course is public when it is published and not deleted. */
export const publicWhere = { status: "published", deletedAt: null } satisfies Prisma.CourseWhereInput;

type Visible = { slug: string; status: string; deletedAt: Date | null; instructorId: string };
const isPublic = (c: Visible) => c.status === "published" && !c.deletedAt;

/**
 * BACKEND_SPEC §2.5. Public courses: everyone. A draft/archived (not deleted) course: admin, the owning instructor or
 * an enrolled learner. A soft-deleted course: only learners who are enrolled (they keep access to what they bought).
 */
export async function canView(c: Visible, viewer: Viewer): Promise<boolean> {
  return (await visibleSlugs([c], viewer)).has(c.slug);
}

/** The slugs among `courses` the viewer may see (one enrollment query for all of them). */
export async function visibleSlugs(courses: Visible[], viewer: Viewer): Promise<Set<string>> {
  const out = new Set(courses.filter(isPublic).map((c) => c.slug));
  const rest = courses.filter((c) => !isPublic(c));
  if (!viewer || rest.length === 0) return out;
  const enrolled = new Set(
    (await prisma.enrollment.findMany({ where: { userId: viewer.userId, courseSlug: { in: rest.map((c) => c.slug) } }, select: { courseSlug: true } })).map((e) => e.courseSlug),
  );
  for (const c of rest) {
    const owner = !!viewer.instructorId && viewer.instructorId === c.instructorId;
    if (enrolled.has(c.slug) || (!c.deletedAt && (viewer.isAdmin || owner))) out.add(c.slug);
  }
  return out;
}
