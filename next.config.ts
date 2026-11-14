import type { NextConfig } from "next";

// Where the ConDex backend runs. Only the dev server uses this, to forward /backend/* to it.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8787";

const nextConfig: NextConfig = {
  // A second dev server (for example one pointed at the real backend) can use its own folder, so the two never fight over .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // The backend does not send CORS headers, so the browser calls this site's own /backend/* and Next forwards it.
  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${BACKEND_URL}/:path*` }];
  },
};

export default nextConfig;
