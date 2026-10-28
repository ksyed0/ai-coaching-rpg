import type { Metadata } from "next";
import type { ReactNode } from "react";
// Styles come only from these files (the CSP allows no inline style attributes): minimal tokens until EPIC-0007, then the classes.
import "../lib/tokens.css";
import "../lib/app.css";

// Every page renders per request: src/proxy.ts puts a fresh nonce in the CSP, and Next can only stamp it on scripts it renders now.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "SceneCoach.ai",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
