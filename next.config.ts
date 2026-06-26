import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // superdoc ships ESM with chunks; ensure Next transpiles it for the client bundle.
  transpilePackages: [
    "@harbour-enterprises/superdoc",
    "@harbour-enterprises/super-editor",
  ],
  // superdoc references browser globals; never SSR it.
  experimental: {
    optimizePackageImports: ["@harbour-enterprises/superdoc"],
  },
  allowedDevOrigins: ["*.space-z.ai"],
};

export default nextConfig;
