import type { RequestHandler } from "express";
import { ApiError } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence on top of SameSite=Lax cookies and JSON-only bodies: every state-changing request must carry a custom
 * header. A cross-site form or <img> cannot set it, and a cross-origin fetch with it triggers a CORS preflight that
 * only our frontend origin passes.
 */
export const csrf: RequestHandler = (req, _res, next) => {
  if (!SAFE_METHODS.has(req.method) && req.get("x-requested-with") !== "fetch") {
    throw new ApiError("forbidden", "Missing X-Requested-With: fetch header");
  }
  next();
};
