import type { ErrorRequestHandler, RequestHandler } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { zodToApiError } from "./validate.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError("notFound", `Route not found: ${req.method} ${req.path}`));
};

// Express recognises error handlers by their 4 arguments
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let e: ApiError;
  if (err instanceof ApiError) e = err;
  else if (err instanceof z.ZodError) e = zodToApiError(err);
  else if (err instanceof SyntaxError && "body" in err) e = new ApiError("validation", "Malformed JSON body"); // body-parser
  else if (err?.type === "entity.too.large") e = new ApiError("validation", "Request body too large");
  else {
    if (!config.isTest) console.error(err);
    e = new ApiError("internal", "Internal server error");
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
};
