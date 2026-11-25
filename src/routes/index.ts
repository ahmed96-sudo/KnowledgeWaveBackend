import { Router } from "express";
import { authRoutes } from "../auth/routes.js";
import { catalogRoutes } from "../catalog/routes.js";
import { learningRoutes } from "../learning/routes.js";
import { siteRoutes } from "../site/routes.js";

export const routes = Router();

routes.get("/health", (_req, res) => {
  res.json({ ok: true });
});

routes.use("/auth", authRoutes);
routes.use(siteRoutes); // /contact, /newsletter
routes.use("/me", learningRoutes); // /me/learning, /me/enrollments, ...
routes.use(catalogRoutes); // /courses, /categories, /instructors, /roadmaps, /testimonials, /search

// Each phase mounts its router here: routes.use("/courses", ...), routes.use("/me", ...), ...
