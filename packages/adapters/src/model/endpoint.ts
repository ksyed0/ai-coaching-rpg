/**
 * Base-URL validation shared by every provider that accepts a configurable endpoint.
 *
 * Policies (a deliberate difference, see select.ts):
 * - "https-or-loopback-http": https anywhere; plain http ONLY for loopback hosts (localhost, 127.0.0.1, [::1]).
 *   Used for hosted/proxied endpoints (OpenRouter, ANTHROPIC_BASE_URL) so an API key never crosses a network in clear text.
 *   The loopback exception exists so a local mock or an on-box proxy works.
 * - "http-or-https": any host over http or https. Used for LOCAL_BASE_URL, which is explicitly a self-hosted endpoint
 *   (often another machine on the LAN, e.g. a GPU box running Ollama) where TLS is usually not available.
 *
 * Errors name the VARIABLE and never echo the value: a mistaken value may contain a credential.
 */
export type EndpointPolicy = "https-or-loopback-http" | "http-or-https";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Returns the normalized base URL (no trailing slash, no query, no fragment) or throws a value-free error. */
export function parseBaseUrl(raw: string | undefined, variable: string, policy: EndpointPolicy): string {
  const value = raw?.trim() ?? "";
  if (value === "") throw new Error(`${variable} is empty`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${variable} is not a valid absolute URL (expected e.g. https://host/path)`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${variable} must use https: or http: (got ${JSON.stringify(url.protocol)})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${variable} must not contain credentials (user:password@host); put the key in the API key variable instead`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`${variable} must not contain a query string or fragment`);
  }
  if (policy === "https-or-loopback-http" && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(`${variable} must use https: (plain http is only allowed for localhost, 127.0.0.1 and [::1])`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}
