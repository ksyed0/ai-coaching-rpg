// Request guards for state-changing routes. Origin plus a custom header is the main CSRF defence; Sec-Fetch-Site is defence in depth.

export function checkOrigin(req: Request, publicOrigin: string): boolean {
  return req.headers.get("Origin") === publicOrigin && req.headers.get("X-Requested-With") === "scenecoach";
}

/** Absent is allowed for older browsers; the Origin check carries the load there. */
export function checkFetchSite(req: Request): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin" || site === "none";
}

const MAX_ADDRESS_CHARS = 64;

/** The LAST X-Forwarded-For entry: the one our own proxy appended; earlier entries are client-supplied. */
export function clientAddress(req: Request): string {
  const raw = req.headers.get("X-Forwarded-For");
  if (!raw) return "unknown";
  const last = raw.split(",").pop()!.trim();
  return last.length > 0 && last.length <= MAX_ADDRESS_CHARS ? last : "unknown";
}
