import { Router } from "express";
import { validate } from "../middleware/validate.js";
import * as c from "./controller.js";
import { BySlugsSchema, CourseQuerySchema, RecommendedSchema, RelatedSchema, SearchSchema } from "./schemas.js";

export const catalogRoutes = Router();

catalogRoutes.get("/courses", validate({ query: CourseQuerySchema }), c.list);
// these two must come before /courses/:slug, or "by-slugs" and "recommended" would be read as slugs
catalogRoutes.get("/courses/by-slugs", validate({ query: BySlugsSchema }), c.bySlugs);
catalogRoutes.get("/courses/recommended", validate({ query: RecommendedSchema }), c.recommended);
catalogRoutes.get("/courses/:slug", c.course);
catalogRoutes.get("/courses/:slug/related", validate({ query: RelatedSchema }), c.related);
catalogRoutes.get("/courses/:slug/reviews", c.reviews);
catalogRoutes.get("/categories", c.categories);
catalogRoutes.get("/instructors", c.instructors);
catalogRoutes.get("/instructors/:id", c.instructor);
catalogRoutes.get("/roadmaps", c.roadmaps);
catalogRoutes.get("/roadmaps/:slug", c.roadmap);
catalogRoutes.get("/testimonials", c.testimonials);
catalogRoutes.get("/search", validate({ query: SearchSchema }), c.search);
