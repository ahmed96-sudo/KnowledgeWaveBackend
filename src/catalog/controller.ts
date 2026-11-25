import type { Request, Response } from "express";
import { parsed } from "../middleware/validate.js";
import { BySlugsSchema, CourseQuerySchema, RecommendedSchema, RelatedSchema, SearchSchema } from "./schemas.js";
import * as service from "./service.js";
import { viewerOf } from "./visibility.js";

const slug = (req: Request) => String(req.params.slug);

export const list = async (req: Request, res: Response) => void res.json(await service.listCourses(parsed(CourseQuerySchema, req.query)));
export const bySlugs = async (req: Request, res: Response) =>
  void res.json(await service.getCoursesBySlugs(parsed(BySlugsSchema, req.query).slugs, viewerOf(req)));
export const recommended = async (req: Request, res: Response) => void res.json(await service.recommended(parsed(RecommendedSchema, req.query)));
export const course = async (req: Request, res: Response) => void res.json(await service.getCourse(slug(req), viewerOf(req)));
export const related = async (req: Request, res: Response) =>
  void res.json(await service.getRelated(slug(req), parsed(RelatedSchema, req.query).limit, viewerOf(req)));
export const reviews = async (req: Request, res: Response) => void res.json(await service.getReviews(slug(req), viewerOf(req)));
export const categories = async (_req: Request, res: Response) => void res.json(await service.getCategories());
export const instructors = async (_req: Request, res: Response) => void res.json(await service.getInstructors());
export const instructor = async (req: Request, res: Response) => void res.json(await service.getInstructor(String(req.params.id)));
export const roadmaps = async (_req: Request, res: Response) => void res.json(await service.getRoadmaps());
export const roadmap = async (req: Request, res: Response) => void res.json(await service.getRoadmap(slug(req)));
export const testimonials = async (_req: Request, res: Response) => void res.json(await service.getTestimonials());
export const search = async (req: Request, res: Response) => {
  const { q, limit } = parsed(SearchSchema, req.query);
  res.json(await service.search(q, limit));
};
