/**
 * US-0072 (EPIC-0003 voice A1c, Task 7): "does the TLS proxy route answer?" A trusted TLS handshake for the hostname (the trust store is
 * Node's default plus `tls.getCACertificates("system")`, built in `cli.ts`, so a certificate the owner's macOS trusts is trusted here
 * too) and any HTTP answer on `/rtc/validate` through it. `address` is where to connect (voice:up uses the node address Caddy binds;
 * default the hostname, as a participant's device would); the SNI name is always the hostname. Never throws.
 */
export type TlsConnect = (host: string, port: number, servername: string) => Promise<{ authorized: boolean; status: number | null }>;

export async function tlsRouteAnswers(o: { hostname: string; port: number; connect: TlsConnect; address?: string }): Promise<boolean> {
  try {
    const r = await o.connect(o.address ?? o.hostname, o.port, o.hostname);
    return r.authorized && r.status !== null;
  } catch { return false; }
}
