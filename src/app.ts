import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { routes } from "./routes/index.js";

/** All routes live under /api (no version segment). */
export const API_PREFIX = "/api";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(API_PREFIX, routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
