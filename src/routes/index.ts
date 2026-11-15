import { Router } from "express";

export const routes = Router();

routes.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Each phase mounts its router here: routes.use("/auth", authRoutes), routes.use("/courses", ...), ...
