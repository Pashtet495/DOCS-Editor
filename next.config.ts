import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // Production: static export → generates out/ directory with HTML/JS/CSS.
  // Electron loads these files directly via file:// (no server needed).
  // Dev: undefined (default) — uses the Next.js dev server with HMR.
  output: isDev ? undefined : "export",
  // For static export, images must be unoptimized (no server-side processing).
  images: isDev ? {} : { unoptimized: true },
  // Static export needs a trailing slash on all routes for file:// loading.
  trailingSlash: !isDev,
  // Use RELATIVE asset paths in production so the static export works via
  // file:// (Electron). Without this, Next emits absolute paths like
  // "/_next/static/..." which don't resolve in file:// mode.
  // In dev, keep the default (absolute) for the dev server.
  assetPrefix: isDev ? undefined : "./",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  transpilePackages: [
    "@harbour-enterprises/superdoc",
    "@harbour-enterprises/super-editor",
  ],
  experimental: {
    optimizePackageImports: ["@harbour-enterprises/superdoc"],
  },
  allowedDevOrigins: ["*.space-z.ai"],
};

export default nextConfig;
