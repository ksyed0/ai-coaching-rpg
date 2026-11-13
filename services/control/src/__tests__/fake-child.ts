import { parseAiPlayerSettings } from "@acr/runtime/players";
import type { ChildMessage, ParentMessage } from "../protocol.js";
import type { ChildHandle } from "../supervisor.js";

/** A scriptable stand-in for a forked runtime, shared by the supervisor test suites. */
export class FakeChild implements ChildHandle {
  /** The requests (every parent message that carries a requestId); bot alerts are kept apart in `alerts`, voice messages (US-0070) in `voice`. */
  sent: Extract<ParentMessage, { requestId: string }>[] = [];
  alerts: Extract<ParentMessage, { type: "bot_alert" }>[] = [];
  voice: Exclude<ParentMessage, { requestId: string } | { type: "bot_alert" }>[] = [];
  killed = 0;
  forced = 0;
  onKill?: () => void;
  onForce?: () => void;
  disconnected = 0;
  private msg: ((m: ChildMessage) => void)[] = [];
  private exitFns: ((c: number | null) => void)[] = [];
  constructor(readonly env: NodeJS.ProcessEnv, readonly logFile: string) {}
  send(m: ParentMessage): boolean { if (m.type === "bot_alert") this.alerts.push(m); else if ("requestId" in m) this.sent.push(m); else this.voice.push(m); return true; }
  onMessage(fn: (m: ChildMessage) => void): void { this.msg.push(fn); }
  onExit(fn: (c: number | null) => void): void { this.exitFns.push(fn); }
  kill(): void { this.killed++; this.onKill?.(); }
  forceKill(): void { this.forced++; this.onForce?.(); }
  disconnect(): void { this.disconnected++; }
  emit(m: unknown): void { for (const f of this.msg) f(m as ChildMessage); }
  exit(code: number | null = 1): void { for (const f of this.exitFns) f(code); }
}

export const CODES = [{ roleId: "cfo", code: "alpha-1" }, { roleId: "cto", code: "beta-2" }];
export const READY = { type: "ready", port: 4321, status: "new", modelLabel: "test-model" } as const;
export const sid = (n: number): string => n.toString(16).padStart(32, "0");
export const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** The AI-player and report parts of a ControlConfig for tests that build one by hand. */
export const AI_CONFIG = (() => {
  const r = parseAiPlayerSettings({});
  if (!r.ok) throw new Error("default AI player settings are invalid");
  return { intentsDir: "/nonexistent/intents", aiPlayer: r.settings, reportsDir: "/nonexistent/reports", reportAccessFile: "/nonexistent/report-access.json", reportAccessDays: 90, evaluateMarginMs: 120_000, accountsFile: "/nonexistent/accounts.json", adminBootstrapPassword: "ChangeMe-Admin-1", adminReset: false };
})();
