/**
 * Get the base path for loading public assets (libs, samples, etc.).
 *
 * In dev (http://localhost:3000): returns "" so paths resolve to "/libs/...".
 * In production (file://): returns "./" so paths resolve to "./libs/..."
 * (relative to the current page). This is needed because absolute paths
 * like "/libs/..." don't resolve in file:// mode — they'd point to the
 * filesystem root.
 *
 * Usage:
 *   import { publicBase } from "@/lib/public-path";
 *   script.src = `${publicBase}libs/mathjs/math.min.js`;
 *
 * Or for a full path:
 *   import { publicAssetUrl } from "@/lib/public-path";
 *   const url = publicAssetUrl("libs/katex/katex.min.js");
 *   // → "/libs/katex/katex.min.js" in dev
 *   // → "./libs/katex/katex.min.js" in production (file://)
 */

export function getPublicBasePath(): string {
  if (typeof window === "undefined") return "";
  if (window.location.protocol === "file:") return "./";
  return "";
}

/** Convenience: the base path (computed once per call). */
export const publicBase = typeof window !== "undefined" && window.location.protocol === "file:" ? "./" : "";

/**
 * Build a full URL for a public asset.
 * @param relPath - path relative to public/, e.g. "libs/mathjs/math.min.js"
 * @returns "/libs/mathjs/math.min.js" in dev, "./libs/mathjs/math.min.js" in prod
 */
export function publicAssetUrl(relPath: string): string {
  return `${publicBase}${relPath}`;
}
