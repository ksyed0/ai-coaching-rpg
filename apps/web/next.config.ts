import type { NextConfig } from "next";

// Static headers for every route, the API included (src/proxy.ts does not run for /api). The per-request nonce CSP, X-Robots-Tag on
// private pages and the other page headers are set by src/proxy.ts (a static policy would block Next's inline bootstrap scripts).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// Turbopack has no extensionAlias, so dev and build run with --webpack (package.json). @acr/events ships TypeScript source that imports "./state.js" (NodeNext style): map .js specifiers back to the .ts/.tsx source.
const extensionAlias = { ".js": [".ts", ".tsx", ".js"] };

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@acr/events"],
  // ws needs its optional native add-ons resolved at runtime, so it is not bundled.
  serverExternalPackages: ["ws"],
  // Next buffers a copy of each request body on the paths src/proxy.ts runs on (pages only); the pages take no body worth more.
  experimental: { proxyClientMaxBodySize: "8kb" },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = { ...webpackConfig.resolve.extensionAlias, ...extensionAlias };
    return webpackConfig;
  },
};

export default config;
