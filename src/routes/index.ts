import { Router } from "express";
import { authRoutes } from "../auth/routes.js";
import { siteRoutes } from "../site/routes.js";

export const routes = Router();

routes.get("/health", (_req, res) => {
  res.json({ ok: true });
});

routes.use("/auth", authRoutes);
routes.use(siteRoutes); // /contact, /newsletter

// Each phase mounts its router here: routes.use("/courses", ...), routes.use("/me", ...), ...
