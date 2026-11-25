import type { RequestHandler } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";

type Schemas = { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType };

/**
 * Validates body/query/params with Zod and replaces them with the parsed (coerced, defaulted) values.
 * Failures become `validation` errors with Zod issues in `details`.
 * Handlers read the result via `req.body`, `req.query`, `req.params` (cast to `z.infer<typeof schema>`).
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    for (const key of ["body", "query", "params"] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const r = schema.safeParse(req[key]);
      if (!r.success) throw zodToApiError(r.error);
      // Express 5 makes req.query a getter, so shadow it on the instance instead of assigning
      Object.defineProperty(req, key, { value: r.data, writable: true, configurable: true, enumerable: true });
    }
    next();
  };

export const zodToApiError = (e: z.ZodError) =>
  new ApiError(
    "validation",
    "Validation failed",
    e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );

/** Types a body/query that `validate()` already parsed with `schema` (Express itself types them loosely). */
export const parsed = <S extends z.ZodType>(_schema: S, value: unknown) => value as z.infer<S>;
