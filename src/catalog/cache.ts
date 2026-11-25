import { config } from "../config.js";
import { createCache } from "../lib/cache.js";

/** Public catalog responses (course list, search, categories...). Off under test unless a test switches it on. */
export const catalogCache = createCache({ ttlMs: 60_000, enabled: !config.isTest });
