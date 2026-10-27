import type { NextConfig } from "next";

// Safe static headers for every route. The per-request nonce CSP lives in src/middleware.ts (a static policy would block Next's inline bootstrap scripts).
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = { ...webpackConfig.resolve.extensionAlias, ...extensionAlias };
    return webpackConfig;
  },
};

export default config;
