// ============================================================================
// math.js lazy loader — loads mathjs from LOCAL file (public/libs/mathjs/)
// as a script tag, then caches it. No CDN dependency.
// ============================================================================

import { publicAssetUrl } from "@/lib/public-path";

let mathModule: any = null;
let loadPromise: Promise<any> | null = null;

/** Synchronously get math.js if already loaded, otherwise null. */
export function getMath(): any | null {
  if (mathModule) return mathModule;
  // Check if mathjs is available globally (loaded via script tag)
  if (typeof window !== "undefined") {
    const w = window as any;
    if (w.math) {
      mathModule = w.math;
      return mathModule;
    }
  }
  return null;
}

/** Asynchronously load math.js from local file. Returns cached module if already loaded. */
export async function loadMath(): Promise<any> {
  if (mathModule) return mathModule;
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("window not available"));
      return;
    }

    const w = window as any;
    // Already loaded globally?
    if (w.math) {
      mathModule = w.math;
      resolve(mathModule);
      return;
    }

    // Load from LOCAL file (served by Next.js from public/libs/ in dev,
    // or as a relative path in Electron production file:// mode).
    const script = document.createElement("script");
    script.src = publicAssetUrl("libs/mathjs/math.min.js");
    script.async = true;
    script.onload = () => {
      if (w.math) {
        mathModule = w.math;
        resolve(mathModule);
      } else {
        reject(new Error("mathjs loaded but window.math not found"));
      }
    };
    script.onerror = () => {
      loadPromise = null;
      reject(new Error("Failed to load mathjs from local file"));
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}

/** Type helper — returns the math.js module type for TypeScript. */
export type MathJsModule = typeof import("mathjs");
