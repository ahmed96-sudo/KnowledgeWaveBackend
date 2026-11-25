import type { Request, Response } from "express";
import { auth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import * as service from "./service.js";
import { getUserData } from "./user-data.js";

/** Learner endpoints act on the EFFECTIVE user (the account an admin is acting as, if any). */
const uid = (req: Request) => auth(req).effectiveUser.id;
const body = <T>(req: Request) => req.body as T;

export const learning = async (req: Request, res: Response) => void res.json(await getUserData(prisma, uid(req)));

export const enroll = async (req: Request, res: Response) =>
  void res.json(await service.enroll(uid(req), body<{ slugs: string[] }>(req).slugs, { isAdmin: auth(req).realUser.role === "admin" }));

export const completeLesson = async (req: Request, res: Response) =>
  void res.json(await service.completeLesson(uid(req), body<{ courseSlug: string }>(req).courseSlug, String(req.params.lessonId)));

export const saveProgress = async (req: Request, res: Response) => {
  await service.savePosition(uid(req), body(req));
  res.status(204).end();
};

export const addNote = async (req: Request, res: Response) => void res.status(201).json(await service.addNote(uid(req), body(req)));

export const deleteNote = async (req: Request, res: Response) => {
  await service.deleteNote(uid(req), String(req.params.id));
  res.status(204).end();
};

export const addToWishlist = async (req: Request, res: Response) => {
  await service.addToWishlist(uid(req), String(req.params.slug));
  res.status(204).end();
};

export const removeFromWishlist = async (req: Request, res: Response) => {
  await service.removeFromWishlist(uid(req), String(req.params.slug));
  res.status(204).end();
};

export const markRead = async (req: Request, res: Response) => {
  await service.markNotificationsRead(uid(req), body<{ ids?: string[] } | undefined>(req)?.ids);
  res.status(204).end();
};

export const review = async (req: Request, res: Response) => void res.json(await service.submitReview(uid(req), String(req.params.slug), body(req)));
export const profile = async (req: Request, res: Response) => void res.json(await service.updateProfile(uid(req), body(req)));
export const settings = async (req: Request, res: Response) => void res.json(await service.updateSettings(uid(req), body(req)));
