// The session state in words (never colour alone): a pill in the header.

export type StatusKind = "lobby" | "running" | "paused" | "ended" | "connecting" | "reconnecting";

const CHIPS: Record<StatusKind, { label: string; tone: string }> = {
  lobby: { label: "Lobby", tone: "warn" },
  running: { label: "Running", tone: "ok" },
  paused: { label: "Paused", tone: "warn" },
  ended: { label: "Ended", tone: "mut" },
  connecting: { label: "Connecting", tone: "mut" },
  reconnecting: { label: "Reconnecting", tone: "warn" },
};

export function StatusChip({ status }: { status: StatusKind }) {
  const c = CHIPS[status];
  return <span className={`pill ${c.tone}`}>{c.label}</span>;
}
