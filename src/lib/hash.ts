import { createHash } from "node:crypto";

/** Session ids and reset tokens are stored only as this hash, so a database leak does not leak live credentials. */
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
