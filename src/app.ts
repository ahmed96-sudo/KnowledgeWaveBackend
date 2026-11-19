import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { loadSession } from "./auth/session.js";
import { config } from "./config.js";
import { csrf } from "./middleware/csrf.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { routes } from "./routes/index.js";

/** All routes live under /api (no version segment). */
export const API_PREFIX = "/api";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy set TRUST_PROXY to the number of proxies (e.g. 1); empty means none (local dev)
  if (config.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY) : config.TRUST_PROXY);
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(API_PREFIX, csrf, loadSession, routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
