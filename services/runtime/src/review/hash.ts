import { createHash } from "node:crypto";
export const sha256 = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex");
