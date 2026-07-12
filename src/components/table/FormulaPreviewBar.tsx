"use client";

/**
 * FormulaPreviewBar — shows the content of the primary selected cell.
 *
 * Layout:
 *   ┌──────┬─────────────────────┬──────────────────────┬──┬──┐
 *   │ A1   │ =20+30/2            │ LaTeX preview        │▲ │Σ │
 *   └──────┴─────────────────────┴──────────────────────┴──┴──┘
 *
 * For non-formula cells: shows the raw text in a single-line input (full width).
 * For formula cells (starts with "="): splits into two halves:
 *   - Left: the raw formula text (editable, 2 rows tall)
 *   - Right: the LaTeX rendering of the formula (via KaTeX, 2 rows tall)
 *
 * Expandable: clicking the expand button makes the LaTeX area grow downward.
 * This PUSHES the grid down (not an overlay) — the parent flex container
 * shrinks the grid to accommodate. When collapsed, the bar is 2 rows (~48px).
 * When expanded, the LaTeX area can grow up to 60vh for tall formulas (matrices).
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronDown, ChevronUp, Sigma } from "lucide-react";
import { getMath, loadMath } from "@/lib/editor/math-loader";
import { publicAssetUrl } from "@/lib/public-path";

/** Load KaTeX from CDN if not already loaded (same pattern as FormulaCalculator). */
function useKatex() {
  const [loaded, setLoaded] = useState(() => {
    if (typeof window === "undefined") return false;
    return !!(window as unknown as { katex?: unknown }).katex;
  });

  useEffect(() => {
    if (loaded) return;
    if (typeof window === "undefined") return;
    const w = window as unknown as { katex?: unknown };
    if (w.katex) return; // already loaded

    if (!document.querySelector('link[href*="katex"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = publicAssetUrl("libs/katex/css/katex.min.css");
      document.head.appendChild(link);
    }
    const existingScript = document.querySelector('script[src*="katex"]');
    if (!existingScript) {
      const script = document.createElement("script");
      script.src = publicAssetUrl("libs/katex/katex.min.js");
      script.onload = () => setLoaded(true);
      document.head.appendChild(script);
    } else {
      const script = existingScript as HTMLScriptElement;
      if (!script.onload) {
        script.onload = () => setLoaded(true);
      }
    }
  }, [loaded]);

  return loaded;
}

/** Convert a spreadsheet formula to LaTeX using math.js (CDN-loaded). */
function formulaToLatex(formula: string): string {
  try {
    const math = getMath();
    if (!math) {
      loadMath().catch(() => {});
      return "";
    }
    const expr = formula.startsWith("=") ? formula.slice(1) : formula;
    if (!expr.trim()) return "";
    const node = math.parse(expr);
    return node.toTex({ parenthesis: "auto" });
  } catch {
    return "";
  }
}

interface FormulaPreviewBarProps {
  cellValue: string | null;
  cellRef: string;
  onEdit: (value: string) => void;
}

export function FormulaPreviewBar({ cellValue, cellRef, onEdit }: FormulaPreviewBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [editValue, setEditValue] = useState(cellValue || "");
  const katexLoaded = useKatex();
  const latexRef = useRef<HTMLDivElement>(null);

  const isFormula = (cellValue || "").startsWith("=");
  const latex = isFormula ? formulaToLatex(cellValue || "") : "";

  // Render LaTeX into the preview div
  useEffect(() => {
    if (!katexLoaded || !latexRef.current || !latex) {
      if (latexRef.current) latexRef.current.innerHTML = "";
      return;
    }
    const w = window as unknown as {
      katex?: {
        render: (tex: string, el: HTMLElement, opts?: Record<string, unknown>) => void;
      };
    };
    try {
      w.katex?.render(latex, latexRef.current, {
        throwOnError: false,
        displayMode: true,
      });
    } catch {
      if (latexRef.current) latexRef.current.textContent = latex;
    }
  }, [latex, katexLoaded]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setEditValue(e.target.value);
      onEdit(e.target.value);
    },
    [onEdit],
  );

  // Collapsed height: 2 rows (~48px) for all cells.
  // Expanded height: up to 60vh for the LaTeX area.
  const collapsedHeight = 48;

  return (
    <div
      className="flex-shrink-0 border-b bg-muted/30 flex"
      style={{ minHeight: collapsedHeight }}
    >
      {/* Cell reference label */}
      <div className="flex-shrink-0 flex items-center justify-center border-r px-2 font-mono text-xs text-muted-foreground w-16">
        {cellRef}
      </div>

      {/* Left: text/formula editor */}
      <div className={`min-w-0 flex ${isFormula ? "w-1/2 border-r" : "flex-1"}`}>
        <input
          type="text"
          value={editValue}
          onChange={handleInputChange}
          placeholder="(пусто)"
          className="w-full bg-transparent text-sm outline-none font-mono px-2 py-1"
          style={{ minHeight: collapsedHeight }}
        />
      </div>

      {/* Right: LaTeX preview (formula cells only) */}
      {isFormula && (
        <div className="flex-1 min-w-0 flex flex-col">
          {/* LaTeX rendering area */}
          <div
            ref={latexRef}
            className="flex-1 overflow-auto px-2 py-1 text-sm"
            style={{
              maxHeight: expanded ? "60vh" : collapsedHeight,
              minHeight: collapsedHeight,
            }}
          />
        </div>
      )}

      {/* Expand/collapse button + formula indicator (formula cells only) */}
      {isFormula && (
        <div className="flex-shrink-0 flex items-center gap-1 px-1 border-l">
          <button
            onClick={() => setExpanded(!expanded)}
            className="border rounded p-1 hover:bg-accent"
            title={expanded ? "Свернуть предпросмотр" : "Развернуть предпросмотр"}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
          </button>
          <Sigma className="h-3.5 w-3.5 text-blue-500" />
        </div>
      )}
    </div>
  );
}
