import { CLIENT_ID_MAX_CHARS, isScenarioId, isValidSessionId } from "@acr/events";

// The BFF's client for the control service (services/control: loopback HTTP, header `x-service-token`, envelope {success, data, error}).
// Every failure becomes a LauncherError whose `reason` is one word from a closed set. The server's own message text is never passed on
// (the BFF shows its own plain messages), and neither the token nor the launcher URL is ever put into an error, a log line or a URL.

export type LauncherReason =
  | "unavailable"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "capacity"
  | "bad_request"
  | "timeout"
  | "failed"
  | "ai_role"
  | "ai_notice"
  | "ai_started"
  | "ai_no_human"
  | "ai_too_many"
  | "ai_invalid"
  | "ai_busy"
  | "ai_budget"
  | "ai_absent"
  | "ai_expired";

/** A failed call to the control service. The message repeats only the reason word. */
export class LauncherError extends Error {
  constructor(readonly reason: LauncherReason) {
    super(`launcher: ${reason}`);
    this.name = "LauncherError";
  }
}

export type SessionInfo = {
  sessionId: string;
  scenarioId: string;
  status: "running" | "stopped" | "ended";
  port?: number;
  modelLabel?: string;
  /** Whether AI players' scores count in the group score (US-0061); absent when the control service did not say. */
  includeInGroup?: boolean;
};
export type RoleCode = { roleId: string; code: string };
/** One line of an AI player's intent log, as the control service returns it (US-0060). */
export type IntentEntry = {
  ts: number;
  sceneId: string | null;
  trigger: "reply" | "nudge" | "prompt";
  outcome: "spoken" | "skipped" | "dropped";
  reason?: "model_failed" | "timeout" | "unusable" | "budget";
  hint?: string;
};
const MAX_INTENT_ENTRIES = 50;
const MAX_HINT_POINTS = 300;
const TRIGGERS: readonly string[] = ["reply", "nudge", "prompt"];
const OUTCOMES: readonly string[] = ["spoken", "skipped", "dropped"];
const REASONS: readonly string[] = ["model_failed", "timeout", "unusable", "budget"];
export type CreatedSession = {
  sessionId: string;
  status: "running";
  port: number;
  modelLabel: string;
  codes: RoleCode[];
};

const DEFAULT_TIMEOUT_MS = 5_000;
/** A create against a hung child can take the child's ready timeout plus two grace periods (ruling R10). */
const DEFAULT_LONG_TIMEOUT_MS = 120_000;
/** Far above any real answer; a larger body is not read to the end. */
const MAX_RESPONSE_CHARS = 1024 * 1024;

/** The control service's ControlError / API codes. Anything else is generic. */
const BY_CODE: Record<string, LauncherReason> = {
  unauthorized: "unauthorized",
  bad_request: "bad_request",
  unknown_scenario: "bad_request",
  payload_too_large: "bad_request",
  not_found: "not_found",
  conflict: "conflict",
  capacity: "capacity",
  timeout: "timeout",
  start_failed: "failed",
  unavailable: "unavailable",
  internal: "failed",
  ai_role: "ai_role",
  ai_notice: "ai_notice",
  ai_started: "ai_started",
  ai_no_human: "ai_no_human",
  ai_too_many: "ai_too_many",
  ai_invalid: "ai_invalid",
  ai_busy: "ai_busy",
  ai_budget: "ai_budget",
  ai_absent: "ai_absent",
  ai_expired: "ai_expired",
};
/** Used only when the answer has no readable error envelope. */
const BY_STATUS: Record<number, LauncherReason> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  409: "conflict",
  413: "bad_request",
  429: "capacity",
  503: "unavailable",
  504: "timeout",
};

// ---- shape checks (no schema library in this app) ----

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65_535;
const isStatus = (v: unknown): v is SessionInfo["status"] =>
  v === "running" || v === "stopped" || v === "ended";

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length <= CLIENT_ID_MAX_CHARS && isScenarioId(v);

const bad = (): never => {
  throw new LauncherError("failed");
};

function toRoleCodes(v: unknown): RoleCode[] {
  if (!Array.isArray(v)) return bad();
  return v.map((e) =>
    isObject(e) && isText(e.roleId) && isText(e.code)
      ? { roleId: e.roleId, code: e.code }
      : bad(),
  );
}
function toInfo(v: unknown): SessionInfo {
  if (
    !isObject(v) ||
    !isText(v.sessionId) ||
    !isText(v.scenarioId) ||
    !isStatus(v.status)
  )
    return bad();
  if (v.port !== undefined && !isPort(v.port)) return bad();
  if (v.modelLabel !== undefined && typeof v.modelLabel !== "string")
    return bad();
  return {
    sessionId: v.sessionId,
    scenarioId: v.scenarioId,
    status: v.status,
    ...(v.port !== undefined && { port: v.port }),
    ...(v.modelLabel !== undefined && { modelLabel: v.modelLabel }),
    ...(typeof v.includeInGroup === "boolean" && { includeInGroup: v.includeInGroup }),
  };
}

/** One entry, picked field by field; null for anything that is not a well-formed entry (an unknown word drops it). */
function toIntent(v: unknown): IntentEntry | null {
  if (!isObject(v)) return null;
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) return null;
  if (v.sceneId !== null && !isId(v.sceneId)) return null;
  if (typeof v.trigger !== "string" || !TRIGGERS.includes(v.trigger)) return null;
  if (typeof v.outcome !== "string" || !OUTCOMES.includes(v.outcome)) return null;
  if (v.reason !== undefined && (typeof v.reason !== "string" || !REASONS.includes(v.reason))) return null;
  if (v.hint !== undefined && typeof v.hint !== "string") return null;
  return {
    ts: v.ts,
    sceneId: v.sceneId,
    trigger: v.trigger as IntentEntry["trigger"],
    outcome: v.outcome as IntentEntry["outcome"],
    ...(v.reason !== undefined && { reason: v.reason as NonNullable<IntentEntry["reason"]> }),
    ...(v.hint !== undefined && { hint: Array.from(v.hint).slice(0, MAX_HINT_POINTS).join("") }),
  };
}

export type LauncherOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  longTimeoutMs?: number;
};

export class LauncherClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly longTimeoutMs: number;

  constructor(o: LauncherOptions) {
    this.base = o.baseUrl;
    this.token = o.token;
    this.fetchFn = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.longTimeoutMs = o.longTimeoutMs ?? DEFAULT_LONG_TIMEOUT_MS;
  }

  async scenarios(): Promise<{ id: string; title: string }[]> {
    const d = await this.call("GET", "/scenarios", undefined, this.timeoutMs);
    if (!Array.isArray(d)) return bad();
    return d.map((e) =>
      isObject(e) && isText(e.id) && typeof e.title === "string"
        ? { id: e.id, title: e.title }
        : bad(),
    );
  }

  async createSession(scenarioId: string): Promise<CreatedSession> {
    const d = await this.call(
      "POST",
      "/sessions",
      { scenarioId },
      this.longTimeoutMs,
    );
    if (!isObject(d)) return bad();
    const info = toInfo({ ...d, scenarioId: "-" });
    if (
      info.status !== "running" ||
      info.port === undefined ||
      typeof info.modelLabel !== "string"
    )
      return bad();
    return {
      sessionId: info.sessionId,
      status: "running",
      port: info.port,
      modelLabel: info.modelLabel,
      codes: toRoleCodes(d.codes),
    };
  }

  async sessions(): Promise<SessionInfo[]> {
    const d = await this.call("GET", "/sessions", undefined, this.timeoutMs);
    if (!Array.isArray(d)) return bad();
    return d.map(toInfo);
  }

  async session(id: string): Promise<SessionInfo> {
    return toInfo(
      await this.call(
        "GET",
        `/sessions/${this.id(id)}`,
        undefined,
        this.timeoutMs,
      ),
    );
  }

  /** The facilitator socket's port and token, always as one pair: they belong to the same start of the child. */
  async facilitator(id: string): Promise<{ port: number; token: string }> {
    const d = await this.call(
      "GET",
      `/sessions/${this.id(id)}/facilitator`,
      undefined,
      this.timeoutMs,
    );
    if (!isObject(d) || !isPort(d.port) || !isText(d.token)) return bad();
    return { port: d.port, token: d.token };
  }

  /** With `reason: "removed"` the runtime treats the reissue as a removal (refused once the session has started). */
  async reissue(
    id: string,
    roleId: string,
    by: string,
    reason?: "removed",
  ): Promise<string> {
    const d = await this.call(
      "POST",
      `/sessions/${this.id(id)}/codes/reissue`,
      reason === undefined ? { roleId, by } : { roleId, by, reason },
      this.longTimeoutMs,
    );
    if (!isObject(d) || !isText(d.code)) return bad();
    return d.code;
  }

  async reissueAll(id: string, by: string): Promise<RoleCode[]> {
    const d = await this.call(
      "POST",
      `/sessions/${this.id(id)}/codes/reissue`,
      { all: true, by },
      this.longTimeoutMs,
    );
    if (!isObject(d)) return bad();
    return toRoleCodes(d.codes);
  }

  async restart(id: string): Promise<SessionInfo & { codes?: RoleCode[] }> {
    const d = await this.call(
      "POST",
      `/sessions/${this.id(id)}/restart`,
      {},
      this.longTimeoutMs,
    );
    const info = toInfo(d);
    const codes = (d as Record<string, unknown>).codes;
    return codes === undefined ? info : { ...info, codes: toRoleCodes(codes) };
  }

  /**
   * Sets which roles AI players play. The reply's `codes` are the human roles' codes only (the control service never returns an AI
   * code); the BFF filters again. `includeInGroup` is sent only when given (absent = keep the current value); the reply must carry it.
   */
  async setAiRoles(
    id: string,
    roles: string[],
    includeInGroup?: boolean,
  ): Promise<{ roles: string[]; includeInGroup: boolean; codes: RoleCode[] }> {
    const d = await this.call(
      "PUT",
      `/sessions/${this.id(id)}/ai-roles`,
      includeInGroup === undefined ? { roles } : { roles, includeInGroup },
      this.longTimeoutMs,
    );
    if (!isObject(d) || !Array.isArray(d.roles) || typeof d.includeInGroup !== "boolean") return bad();
    return {
      roles: d.roles.map((r) => (isId(r) ? r : bad())),
      includeInGroup: d.includeInGroup,
      codes: toRoleCodes(d.codes),
    };
  }

  /** The last intents of one AI player. A role id that is not an id never reaches the network. */
  async intents(id: string, roleId: string): Promise<IntentEntry[]> {
    if (
      typeof roleId !== "string" ||
      !isId(roleId)
    )
      throw new LauncherError("not_found");
    const d = await this.call(
      "GET",
      `/sessions/${this.id(id)}/ai-roles/${encodeURIComponent(roleId)}/intents`,
      undefined,
      this.timeoutMs,
    );
    if (!isObject(d) || !Array.isArray(d.entries)) return bad();
    return d.entries
      .map(toIntent)
      .filter((e): e is IntentEntry => e !== null)
      .slice(-MAX_INTENT_ENTRIES);
  }

  /** Reserves the next turn of an AI player; the reservation (32 hex) is a secret between the BFF and the control service. */
  async reserveTurn(id: string, roleId: string): Promise<string> {
    const d = await this.call("POST", this.turnPath(id, roleId, "reserve"), {}, this.timeoutMs);
    if (!isObject(d) || typeof d.reservation !== "string" || !/^[0-9a-f]{32}$/.test(d.reservation)) return bad();
    return d.reservation;
  }

  /** Starts the reserved turn. The hint goes only here. */
  async runTurn(id: string, roleId: string, reservation: string, hint?: string): Promise<void> {
    await this.call(
      "POST",
      this.turnPath(id, roleId, "run"),
      hint === undefined ? { reservation } : { reservation, hint },
      this.timeoutMs,
    );
  }

  async releaseTurn(id: string, roleId: string, reservation: string): Promise<void> {
    await this.call("POST", this.turnPath(id, roleId, "release"), { reservation }, this.timeoutMs);
  }

  private turnPath(id: string, roleId: string, leaf: "reserve" | "run" | "release"): string {
    if (!isId(roleId)) throw new LauncherError("not_found");
    return `/sessions/${this.id(id)}/ai-roles/${encodeURIComponent(roleId)}/${leaf}`;
  }

  /** A session id is checked before it goes into a path, so nothing can change the route. */
  private id(raw: string): string {
    if (!isValidSessionId(raw)) throw new LauncherError("not_found");
    return encodeURIComponent(raw);
  }

  /** One request. Resolves with the envelope's `data`, or throws a LauncherError; nothing from the transport escapes. */
  private async call(
    method: "GET" | "POST" | "PUT",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.fetchFn(new URL(path, this.base).toString(), {
        method,
        signal,
        redirect: "error",
        headers: {
          "x-service-token": this.token,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      status = res.status;
      text = await res.text();
    } catch {
      throw new LauncherError(signal.aborted ? "timeout" : "unavailable");
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new LauncherError("failed");
    let env: unknown;
    try {
      env = JSON.parse(text);
    } catch {
      env = undefined;
    }
    const e = isObject(env) ? env : undefined;
    if (status >= 200 && status < 300) {
      if (e?.success !== true || e.data === null || e.data === undefined)
        throw new LauncherError("failed");
      return e.data;
    }
    const err = e && isObject(e.error) ? e.error : undefined;
    if (err && typeof err.code === "string")
      throw new LauncherError(
        Object.hasOwn(BY_CODE, err.code) ? BY_CODE[err.code]! : "failed",
      );
    throw new LauncherError(BY_STATUS[status] ?? "failed");
  }
}
