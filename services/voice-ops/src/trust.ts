/**
 * US-0072 (EPIC-0003 voice A1c, Task 7; review B2 F9): the CAs the TLS route checks trust: Node's bundle plus the system store
 * (`tls.getCACertificates("system")`, Node 22.15 and newer), so a certificate the owner's machine trusts is trusted here too. Without
 * that function the system store is missing; `system: false` lets voice:up and voice:check say so instead of failing the route check
 * with no reason. The package's `engines` field asks for Node 22.15 or newer.
 */
export type TlsLike = { rootCertificates: readonly string[]; getCACertificates?: (type: "system") => string[] };

export const NO_SYSTEM_STORE_SENTENCE = `this Node (${process.version}) cannot read the system certificate store: a certificate trusted only by this machine's keychain fails the TLS route check; use Node 22.15 or newer`;

export function trustStore(t: TlsLike): { cas: string[]; system: boolean } {
  if (typeof t.getCACertificates !== "function") return { cas: [...t.rootCertificates], system: false };
  try { return { cas: [...t.rootCertificates, ...t.getCACertificates("system")], system: true }; }
  catch { return { cas: [...t.rootCertificates], system: false }; }
}
