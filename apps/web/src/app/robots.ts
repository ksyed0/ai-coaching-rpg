import type { MetadataRoute } from "next";
import { PRIVATE_PREFIXES } from "../server/headers";

// robots.txt: the private routes are never crawled (they also send X-Robots-Tag; join links carry no personal data).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: [...PRIVATE_PREFIXES] } };
}
