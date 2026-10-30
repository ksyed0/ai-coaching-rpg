import type { ChildMessage, ParentMessage } from "../protocol.js";
import type { ChildHandle } from "../supervisor.js";

/** A scriptable stand-in for a forked runtime, shared by the supervisor test suites. */
export class FakeChild implements ChildHandle {
  sent: ParentMessage[] = [];
  killed = 0;
  forced = 0;
  onKill?: () => void;
  onForce?: () => void;
  disconnected = 0;
  private msg: ((m: ChildMessage) => void)[] = [];
  private exitFns: ((c: number | null) => void)[] = [];
  constructor(readonly env: NodeJS.ProcessEnv, readonly logFile: string) {}
  send(m: ParentMessage): boolean { this.sent.push(m); return true; }
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
