/** US-0054: every player must consent before the start gate opens. For tests that drive raw sockets and have already joined them. */
export function consentAll(clients: { send(m: unknown): void }[], noticeVersion = "v1"): void {
  for (const c of clients) c.send({ type: "consent", noticeVersion });
}
