"use client";

/**
 * RightPanel — collapsible, resizable side panel for the table editor.
 *
 * Features:
 *  - Resizable width via a drag handle on the LEFT edge (pointer events).
 *  - Collapsible: when collapsed, shows a thin vertical bar with a "►" button.
 *  - Sync scroll: the content area's scrollTop follows the TableGrid's scroll
 *    container, so anchored blocks stay aligned with their grid rows.
 *  - Auto-fill label blocks: each `rightPanelBlock` in the table doc renders
 *    as a small label at the vertical position of its row, anchored to the
 *    LEFT edge (the boundary between grid and panel).
 *      • Click  → opens an edit popover (label, description, delete).
 *      • Drag right → detaches the block from the boundary. When the X
 *        offset > 25 px, an SVG line connects the boundary to the block.
 *        When released with offset ≤ 25 px, the block snaps back to 0.
 *
 * The blocks come from the store (`rightPanelBlocks` on the table doc), and
 * cell values come from the live draft (so the panel reflects in-progress
 * edits immediately).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Link2,
  Eye,
  EyeOff,
  Trash2,
  Save,
  X,
  FunctionSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import { useEditorStore } from "@/store/editor-store";
import type { TableDoc, RightPanelBlock, CellLink, Cell } from "@/lib/table/types";
import type { FormulaEntry } from "@/lib/editor/types";
import {
  classifyFormula,
  formatFormulaValue,
  isMatrixFormula,
  formulaToLatex,
} from "@/lib/table/calc-engine";
import { publicAssetUrl } from "@/lib/public-path";

const MIN_WIDTH = 240;
const MAX_WIDTH = 800;
const ROW_HEIGHT = 26;
const DETACH_THRESHOLD = 25;

/** Brick-red palette for formula links (distinct from AutoFill's blue). */
const FORMULA_COLOR = "#991b1b";
const FORMULA_COLOR_LIGHT = "#fee2e2";

export interface RightPanelProps {
  width: number;
  onWidthChange: (w: number) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** The live draft — used to read cell values for the AF label blocks. */
  doc: TableDoc;
  /** Table ID — used to read rightPanelBlocks and cellLinks from the store. */
  tableId: string;
  /** Ref to the TableGrid's scroll container — used for sync scroll. */
  gridScrollRef: React.RefObject<HTMLDivElement | null>;
  /** Called when the user clicks Delete in an AF block's edit popover. */
  onDeleteCellLink: (linkId: string) => void;
  /** Called when the user clicks Delete in a formula block's popover. */
  onDeleteFormulaLink: (linkId: string) => void;
}

export function RightPanel(props: RightPanelProps) {
  const {
    width,
    onWidthChange,
    collapsed,
    onToggle,
    doc,
    tableId,
    gridScrollRef,
    onDeleteCellLink,
    onDeleteFormulaLink,
  } = props;

  // ---- Resize handle state (pointer capture drag) ----
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = startXRef.current - e.clientX;
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, startWidthRef.current + dx),
      );
      onWidthChange(next);
    },
    [onWidthChange],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    setIsDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        draggingRef.current = false;
        setIsDragging(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDragging]);

  // ---- Sync scroll state ----
  const contentRef = useRef<HTMLDivElement>(null);
  const [syncScroll, setSyncScroll] = useState(true);
  /** Last known grid scrollTop — frozen when sync is disabled so blocks
   *  stay at the position they were when sync was turned off. */
  const frozenScrollTopRef = useRef(0);

  // ---- Store selectors: blocks + cellLinks for THIS table ----
  const blocks = useEditorStore(
    (s) => s.tableDocs.find((t) => t.id === tableId)?.rightPanelBlocks ?? [],
  );
  const cellLinks = useEditorStore(
    (s) => s.tableDocs.find((t) => t.id === tableId)?.cellLinks ?? [],
  );
  const updateRightPanelBlockOffset = useEditorStore(
    (s) => s.updateRightPanelBlockOffset,
  );
  // Subscribe to formulas array only (not the entire formulaStore object).
  // We use a signature-based selector to avoid re-renders when formulaStore
  // gets a new reference but the formulas content is unchanged (happens on
  // every recalcAndSyncFormulas call). The signature captures id+value+formula
  // for each entry — enough to detect any meaningful change.
  const formulaSig = useEditorStore(
    (s) => {
      const fs = s.formulaStore;
      if (!fs) return "";
      return fs.formulas.map((f) => `${f.id}:${f.value ?? ""}:${f.formula}`).join("|");
    },
  );
  const setRightPanelBlockShowLatex = useEditorStore(
    (s) => s.setRightPanelBlockShowLatex,
  );

  // Build a map cellId → cell value (from the live draft).
  // Covers BOTH AutoFill links (cell.linkId) and formula links (cell.formulaLinkId).
  const cellValuesByCellId = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const row of doc.cells) {
      if (!row) continue;
      for (const cell of row) {
        if (cell?.linkId) {
          m.set(cell.linkId, String(cell.computed ?? cell.raw ?? ""));
        }
        if (cell?.formulaLinkId) {
          m.set(cell.formulaLinkId, String(cell.computed ?? cell.raw ?? ""));
        }
      }
    }
    return m;
  }, [doc.cells]);

  // Build a map cellLinkId → CellLink (for label / description).
  const cellLinkMap = React.useMemo(() => {
    const m = new Map<string, CellLink>();
    for (const cl of cellLinks) m.set(cl.id, cl);
    return m;
  }, [cellLinks]);

  // Build a map formulaId → FormulaEntry (for formula blocks).
  // Depends on formulaSig so the map is rebuilt only when formula values or
  // expressions actually change — not on every formulaStore reference update.
  const formulaMap = React.useMemo(() => {
    const m = new Map<string, FormulaEntry>();
    const fs = useEditorStore.getState().formulaStore;
    if (fs) {
      for (const f of fs.formulas) m.set(f.id, f);
    }
    return m;
  }, [formulaSig]);

  // ---- Sync scroll: grid scroll → panel content scrollTop ----
  useEffect(() => {
    const grid = gridScrollRef.current;
    if (!grid) return;
    const onScroll = () => {
      if (!syncScroll) return;
      frozenScrollTopRef.current = grid.scrollTop;
      if (contentRef.current) {
        contentRef.current.scrollTop = grid.scrollTop;
      }
    };
    grid.addEventListener("scroll", onScroll, { passive: true });
    // Initial sync.
    if (syncScroll && contentRef.current) {
      contentRef.current.scrollTop = grid.scrollTop;
      frozenScrollTopRef.current = grid.scrollTop;
    }
    return () => grid.removeEventListener("scroll", onScroll);
  }, [gridScrollRef, syncScroll]);

  // When sync re-enables, jump back to the grid's current scrollTop.
  useEffect(() => {
    if (syncScroll && contentRef.current && gridScrollRef.current) {
      contentRef.current.scrollTop = gridScrollRef.current.scrollTop;
    }
  }, [syncScroll, gridScrollRef]);

  // -----------------------------------------------------------------------
  // Collapsed view: a thin vertical bar with an expand button.
  // -----------------------------------------------------------------------

  if (collapsed) {
    return (
      <div className="flex h-full w-10 flex-col items-center justify-start border-l bg-background py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Развернуть панель"
          title="Развернуть панель"
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="mt-2 [writing-mode:vertical-rl] text-xs text-muted-foreground">
          Панель элементов
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Expanded view: drag handle + header + scrollable content with blocks.
  // -----------------------------------------------------------------------

  const totalContentHeight = Math.max(doc.rowCount * ROW_HEIGHT, 1);

  return (
    <div
      className="relative flex h-full flex-col border-l bg-background"
      style={{ width, minWidth: MIN_WIDTH, flexShrink: 0 }}
    >
      {/* Drag handle on the left edge */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          "absolute left-0 top-0 z-30 h-full w-1 cursor-col-resize bg-border transition-colors",
          "hover:bg-primary/50",
          isDragging && "bg-primary",
        )}
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину панели"
      />

      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Link2 className="h-4 w-4 text-primary flex-shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            Панель элементов
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => setSyncScroll((s) => !s)}
            aria-label={syncScroll ? "Выключить синхр. прокрутки" : "Включить синхр. прокрутки"}
            title={syncScroll ? "Синхр. прокрутка вкл." : "Синхр. прокрутка выкл."}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent",
              syncScroll && "text-primary bg-primary/10",
            )}
          >
            {syncScroll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Свернуть панель"
            title="Свернуть панель"
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content area — overflow hidden, scroll set programmatically.
          Contains a tall inner canvas so blocks can be positioned at
          (row * ROW_HEIGHT) and stay aligned with grid rows via scrollTop. */}
      <div
        ref={contentRef}
        className="relative flex-1 overflow-hidden bg-muted/10"
      >
        {blocks.length === 0 ? (
          <div className="h-full" />
        ) : (
          <div
            className="relative w-full"
            style={{ height: totalContentHeight }}
          >
            {/* SVG layer for connecting lines (drawn BEHIND blocks). */}
            <svg
              className="pointer-events-none absolute inset-0"
              width="100%"
              height={totalContentHeight}
              style={{ overflow: "visible" }}
            >
              {blocks.map((block) => {
                const ox = block.offsetX ?? 0;
                if (ox <= DETACH_THRESHOLD) return null;
                const cy = block.row * ROW_HEIGHT + ROW_HEIGHT / 2;
                const isFormulaBlock = block.type === "calculator-var";
                return (
                  <line
                    key={`line-${block.id}`}
                    x1={0}
                    y1={cy}
                    x2={ox}
                    y2={cy}
                    stroke={isFormulaBlock ? FORMULA_COLOR : "#1e40af"}
                    strokeWidth={1.5}
                    strokeDasharray="3,2"
                  />
                );
              })}
            </svg>

            {/* Block layer */}
            {blocks.map((block) => {
              const cellLink = block.cellLinkId ? cellLinkMap.get(block.cellLinkId) : undefined;
              // Formula block → render FormulaBlock; otherwise AfBlock.
              if (block.type === "calculator-var") {
                const formula = cellLink?.formulaId
                  ? formulaMap.get(cellLink.formulaId)
                  : undefined;
                // Collect cell values for this formula link.
                // For formula links, cells store formulaLinkId === cellLink.id
                // (not the internal cellId). So look up by cellLink.id.
                const cellValues: string[] = cellLink
                  ? [cellValuesByCellId.get(cellLink.id) ?? ""].filter((v) => v !== "")
                  : [];
                return (
                  <FormulaBlock
                    key={block.id}
                    block={block}
                    cellLink={cellLink}
                    formula={formula}
                    cellValues={cellValues}
                    onOffsetChange={(ox) =>
                      updateRightPanelBlockOffset(tableId, block.id, ox)
                    }
                    onToggleShowLatex={(show) =>
                      setRightPanelBlockShowLatex(tableId, block.id, show)
                    }
                    onDelete={() =>
                      block.cellLinkId && onDeleteFormulaLink(block.cellLinkId)
                    }
                  />
                );
              }
              // AutoFill block (default).
              const cellValues: string[] = cellLink
                ? cellLink.cellIds
                    .map((cid) => cellValuesByCellId.get(cid) ?? "")
                    .filter((v) => v !== "")
                : [];
              return (
                <AfBlock
                  key={block.id}
                  block={block}
                  cellLink={cellLink}
                  cellValues={cellValues}
                  onOffsetChange={(ox) =>
                    updateRightPanelBlockOffset(tableId, block.id, ox)
                  }
                  onDelete={() =>
                    block.cellLinkId && onDeleteCellLink(block.cellLinkId)
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AfBlock — a single auto-fill label block anchored to a row.
// ---------------------------------------------------------------------------

interface AfBlockProps {
  block: RightPanelBlock;
  cellLink: CellLink | undefined;
  /** All live cell values for this block's link (one per cellId, in order).
   *  For a single-cell link this has 1 element; for a range, N elements. */
  cellValues: string[];
  onOffsetChange: (offsetX: number) => void;
  onDelete: () => void;
}

function AfBlock(props: AfBlockProps) {
  const { block, cellLink, cellValues, onOffsetChange, onDelete } = props;

  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editDesc, setEditDesc] = useState("");

  const dragStateRef = useRef({
    dragging: false,
    startX: 0,
    startOffset: 0,
    moved: false,
  });

  const blockRef = useRef<HTMLDivElement>(null);

  const offsetX = block.offsetX ?? 0;
  const centerY = block.row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const blockHeight = 22;

  // Open the edit popover with current values.
  const openEdit = useCallback(() => {
    setEditLabel(cellLink?.label ?? "");
    setEditDesc(cellLink?.description ?? "");
    setEditing(true);
  }, [cellLink]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Don't start drag if the popover is open (let the popover handle clicks).
      if (editing) return;
      e.preventDefault();
      e.stopPropagation();
      dragStateRef.current = {
        dragging: true,
        startX: e.clientX,
        startOffset: offsetX,
        moved: false,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [offsetX, editing],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragStateRef.current.dragging) return;
      const dx = e.clientX - dragStateRef.current.startX;
      if (Math.abs(dx) > 3) dragStateRef.current.moved = true;
      const next = Math.max(0, dragStateRef.current.startOffset + dx);
      onOffsetChange(next);
    },
    [onOffsetChange],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragStateRef.current.dragging) return;
      dragStateRef.current.dragging = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      // If it was a click (no significant movement), open the edit popover.
      if (!dragStateRef.current.moved) {
        openEdit();
        return;
      }
      // Snap-back logic: if released within the detach threshold, snap to 0.
      const finalOffset = block.offsetX ?? 0;
      if (finalOffset <= DETACH_THRESHOLD) {
        onOffsetChange(0);
      }
    },
    [block.offsetX, onOffsetChange, openEdit],
  );

  const isDetached = offsetX > DETACH_THRESHOLD;
  const labelText = cellLink?.label ?? "(без связи)";
  const descText = cellLink?.description ?? "";

  // Build a compact display string from the live cell values:
  // - 0 values: "—"
  // - 1 value: the value itself
  // - N values: first value + "+N —" (e.g. "100 +4 —")
  const firstValue = cellValues[0] ?? "";
  const hasMultiple = cellValues.length > 1;
  const displayValue = hasMultiple
    ? `${firstValue || "—"} +${cellValues.length - 1}`
    : firstValue;

  return (
    <Popover open={editing} onOpenChange={setEditing}>
      <PopoverAnchor asChild>
        <div
          ref={blockRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="button"
          tabIndex={0}
          title={`${labelText}${descText ? " — " + descText : ""}`}
          className={cn(
            "absolute flex items-center gap-1.5 rounded-md border bg-background px-2 shadow-sm",
            "cursor-grab active:cursor-grabbing select-none touch-none",
            "hover:shadow-md hover:border-primary/40 transition-shadow",
            isDetached ? "border-primary/60" : "border-border",
            "focus:outline-none focus:ring-2 focus:ring-primary/40",
          )}
          style={{
            top: centerY - blockHeight / 2,
            left: offsetX,
            height: blockHeight,
            maxWidth: "calc(100% - 4px)",
            zIndex: 20,
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openEdit();
            }
          }}
        >
          <span
            className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
            style={{ backgroundColor: "#1e40af" }}
            aria-hidden
          />
          <span className="text-xs font-medium text-foreground truncate max-w-[100px]">
            {labelText}
          </span>
          <span className="text-xs text-muted-foreground font-mono truncate">
            {displayValue || "—"}
          </span>
        </div>
      </PopoverAnchor>

      <PopoverContent
        className="w-72"
        align="start"
        sideOffset={4}
        style={{ zIndex: 10010 }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Связь с АЗ</span>
            </div>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`af-label-${block.id}`} className="text-xs">
              Имя поля
            </Label>
            <Input
              id={`af-label-${block.id}`}
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              className="h-8"
              placeholder="Имя"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`af-desc-${block.id}`} className="text-xs">
              Описание
            </Label>
            <Input
              id={`af-desc-${block.id}`}
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              className="h-8"
              placeholder="Описание для AI"
            />
          </div>

          <div className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            {hasMultiple ? (
              <>
                Значений: <span className="font-mono text-foreground">{cellValues.length}</span>
                <br />
                Первое: <span className="font-mono text-foreground">{firstValue || "—"}</span>
                <br />
                Все:{" "}
                <span className="font-mono text-foreground break-all">
                  {cellValues.join(", ") || "—"}
                </span>
              </>
            ) : (
              <>
                Значение:{" "}
                <span className="font-mono text-foreground">{firstValue || "—"}</span>
                <br />
                Строка:{" "}
                <span className="font-mono text-foreground">{block.row + 1}</span>
              </>
            )}
          </div>

          <div className="flex justify-between items-center pt-1">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setEditing(false);
                onDelete();
              }}
            >
              <Trash2 className="h-4 w-4" />
              Удалить
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                // Save edits — we currently only have label/description edits,
                // which are NOT separately exposed as a store action. The
                // minimal viable behavior is to close the popover (the AF
                // field's label/description can be edited in the AF editor).
                // If a future updateCellLink action exists, wire it here.
                setEditing(false);
              }}
            >
              <Save className="h-4 w-4" />
              Закрыть
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// useKatex — load KaTeX from local libs and report readiness.
// Module-level guard prevents duplicate <link>/<script> injection when
// multiple FormulaBlock / KatexRender components mount simultaneously before
// the script finishes loading.
// ---------------------------------------------------------------------------

let katexLoadInitiated = false;

function useKatex() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { katex?: unknown };
    if (w.katex) {
      setLoaded(true);
      return;
    }
    // Module-level guard: if another component already started loading KaTeX,
    // don't inject a second <link>/<script>. We still poll for readiness.
    if (katexLoadInitiated) return;
    katexLoadInitiated = true;

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = publicAssetUrl("libs/katex/css/katex.min.css");
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = publicAssetUrl("libs/katex/katex.min.js");
    script.onload = () => setLoaded(true);
    script.onerror = () => {
      setLoaded(false);
      katexLoadInitiated = false; // allow retry on failure
    };
    document.head.appendChild(script);
  }, []);
  if (typeof window !== "undefined" && (window as unknown as { katex?: unknown }).katex) {
    return true;
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// FormulaBlock — a calculator-variable label block anchored to a row.
// Brick-red palette. Popover shows formula info + "show formula" checkbox.
// When the checkbox is on, KaTeX renders the formula LaTeX to the right.
// ---------------------------------------------------------------------------

interface FormulaBlockProps {
  block: RightPanelBlock;
  cellLink: CellLink | undefined;
  formula: FormulaEntry | undefined;
  /** Live cell values for this block's link (one per cellId). */
  cellValues: string[];
  onOffsetChange: (offsetX: number) => void;
  onToggleShowLatex: (show: boolean) => void;
  onDelete: () => void;
}

function FormulaBlock(props: FormulaBlockProps) {
  const { block, cellLink, formula, cellValues, onOffsetChange, onToggleShowLatex, onDelete } = props;
  const [editing, setEditing] = useState(false);
  const katexLoaded = useKatex();
  const latexRef = useRef<HTMLSpanElement>(null);

  const dragStateRef = useRef({
    dragging: false,
    startX: 0,
    startOffset: 0,
    moved: false,
  });

  const offsetX = block.offsetX ?? 0;
  const centerY = block.row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const blockHeight = 22;
  const showLatex = !!block.showFormulaLatex;

  // Determine the formula kind for display. Memoized because classifyFormula
  // calls math.parse + traverse (expensive). The cache in calc-engine.ts
  // helps, but useMemo avoids even the cache lookup on every render.
  const kind = useMemo(() => {
    if (!formula) return "constant" as const;
    if (isMatrixFormula(formula.formula)) return "matrix" as const;
    return classifyFormula(formula) === "function" ? "function" : "constant";
  }, [formula]);

  // Compute LaTeX from the formula expression (real-time).
  const latexStr = useMemo(() => {
    if (!formula) return "";
    return formulaToLatex(formula.formula);
  }, [formula]);

  // Render LaTeX into the ref element whenever it changes.
  useEffect(() => {
    if (!showLatex || !latexRef.current || !latexStr) return;
    try {
      const katex = (window as unknown as { katex?: { render: (tex: string, el: HTMLElement, opts?: Record<string, unknown>) => void } }).katex;
      if (katex) {
        katex.render(latexStr, latexRef.current, { throwOnError: false, displayMode: false });
      } else {
        latexRef.current.textContent = latexStr;
      }
    } catch {
      if (latexRef.current) latexRef.current.textContent = latexStr;
    }
  }, [showLatex, latexStr, katexLoaded]);

  const openEdit = useCallback(() => {
    setEditing(true);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      e.preventDefault();
      e.stopPropagation();
      dragStateRef.current = {
        dragging: true,
        startX: e.clientX,
        startOffset: offsetX,
        moved: false,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [offsetX, editing],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragStateRef.current.dragging) return;
      const dx = e.clientX - dragStateRef.current.startX;
      if (Math.abs(dx) > 3) dragStateRef.current.moved = true;
      const next = Math.max(0, dragStateRef.current.startOffset + dx);
      onOffsetChange(next);
    },
    [onOffsetChange],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragStateRef.current.dragging) return;
      dragStateRef.current.dragging = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (!dragStateRef.current.moved) {
        openEdit();
        return;
      }
      const finalOffset = block.offsetX ?? 0;
      if (finalOffset <= DETACH_THRESHOLD) {
        onOffsetChange(0);
      }
    },
    [block.offsetX, onOffsetChange, openEdit],
  );

  const isDetached = offsetX > DETACH_THRESHOLD;
  const labelText = formula?.name || cellLink?.label || "(без формулы)";
  const firstValue = cellValues[0] ?? "";
  const hasMultiple = cellValues.length > 1;
  const displayValue = hasMultiple
    ? `${firstValue || "—"} +${cellValues.length - 1}`
    : firstValue || (formula ? formatFormulaValue(formula) : "—");

  const kindLabel =
    kind === "matrix" ? "матрица" : kind === "function" ? "функция" : "конст.";

  return (
    <Popover open={editing} onOpenChange={setEditing}>
      <div
        className="absolute flex items-center gap-1.5"
        style={{
          top: centerY - blockHeight / 2,
          left: offsetX,
          height: blockHeight,
          maxWidth: "calc(100% - 4px)",
          zIndex: 20,
        }}
      >
        <PopoverAnchor asChild>
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            role="button"
            tabIndex={0}
            title={`${labelText}${formula?.comment ? " — " + formula.comment : ""}`}
            className={cn(
              "flex items-center gap-1.5 rounded-md border bg-background px-2 shadow-sm h-full",
              "cursor-grab active:cursor-grabbing select-none touch-none",
              "hover:shadow-md transition-shadow",
              isDetached ? "border-[#991b1b]/60" : "border-border",
              "focus:outline-none focus:ring-2 focus:ring-[#991b1b]/40",
            )}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openEdit();
              }
            }}
          >
            <span
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: FORMULA_COLOR }}
              aria-hidden
            />
            <span className="text-xs font-medium text-foreground truncate max-w-[80px]">
              {labelText}
            </span>
            <span className="text-xs text-muted-foreground font-mono truncate">
              {displayValue}
            </span>
          </div>
        </PopoverAnchor>

        {/* LaTeX render area (to the right of the button, when showLatex is on) */}
        {showLatex && latexStr && (
          <span
            ref={latexRef}
            className="ml-1 inline-flex items-center px-1 py-0.5 rounded bg-[#fef2f2] border border-[#fecaca] text-[#991b1b] text-xs overflow-hidden max-w-[300px]"
            title={latexStr}
          />
        )}
      </div>

      <PopoverContent
        className="w-80"
        align="start"
        sideOffset={4}
        style={{ zIndex: 10010 }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FunctionSquare className="h-4 w-4 text-[#991b1b]" />
              <span className="text-sm font-medium">Связь с формулой</span>
              <span className="text-xs text-muted-foreground">({kindLabel})</span>
            </div>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {formula && (
            <>
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">Имя</Label>
                <div className="font-mono text-sm font-medium text-[#991b1b]">
                  {formula.name}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">Формула</Label>
                <div className="font-mono text-xs bg-muted/50 rounded px-2 py-1 break-all">
                  {formula.formula}
                </div>
              </div>

              {formula.comment && (
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Комментарий</Label>
                  <div className="text-xs">{formula.comment}</div>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">Значение</Label>
                <div className="font-mono text-sm">
                  {hasMultiple
                    ? `${cellValues.length} значений: ${cellValues.join(", ")}`
                    : displayValue}
                </div>
              </div>

              {/* LaTeX preview in popover */}
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">LaTeX</Label>
                <div className="rounded bg-white border px-2 py-1.5 overflow-x-auto">
                  <KatexRender latex={latexStr} />
                </div>
              </div>

              {/* Show formula checkbox */}
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={showLatex}
                  onCheckedChange={(v) => onToggleShowLatex(!!v)}
                />
                <span className="text-xs">Показать формулу рядом с кнопкой</span>
              </label>
            </>
          )}

          {!formula && (
            <div className="text-xs text-muted-foreground">
              Формула не найдена в калькуляторе. Возможно, она была удалена.
            </div>
          )}

          <div className="flex justify-between items-center pt-1">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setEditing(false);
                onDelete();
              }}
            >
              <Trash2 className="h-4 w-4" />
              Удалить связь
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setEditing(false)}
            >
              <Save className="h-4 w-4" />
              Закрыть
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// KatexRender — renders a LaTeX string into a span using KaTeX.
// ---------------------------------------------------------------------------

function KatexRender({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const katexLoaded = useKatex();
  useEffect(() => {
    if (!ref.current || !latex) return;
    try {
      const katex = (window as unknown as { katex?: { render: (tex: string, el: HTMLElement, opts?: Record<string, unknown>) => void } }).katex;
      if (katex) {
        katex.render(latex, ref.current, { throwOnError: false, displayMode: false });
      } else {
        ref.current.textContent = latex;
      }
    } catch {
      if (ref.current) ref.current.textContent = latex;
    }
  }, [latex, katexLoaded]);
  return <span ref={ref} className="text-sm" />;
}
