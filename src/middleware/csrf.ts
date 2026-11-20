import type { RequestHandler } from "express";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const allowedOrigin = config.CORS_ORIGIN.replace(/\/+$/, "");

/**
 * CSRF defence on top of SameSite=Lax cookies and JSON-only bodies. Every state-changing request must:
 *  1. carry a custom header: a cross-site form or <img> cannot set it, and a cross-origin fetch with it triggers a
 *     CORS preflight that only our frontend origin passes;
 *  2. come from our frontend: browsers always send `Origin` on such requests, so any other value (including "null")
 *     is refused. This also covers sibling subdomains the header alone would not stop. A request with no Origin is a
 *     non-browser client (curl, server-to-server), which CSRF cannot affect, so it only needs the header.
 */
export const csrf: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get("x-requested-with") !== "fetch") throw new ApiError("forbidden", "Missing X-Requested-With: fetch header");
  const origin = req.get("origin");
  if (origin !== undefined && origin !== allowedOrigin) throw new ApiError("forbidden", "Cross-origin request blocked");
  next();
};
