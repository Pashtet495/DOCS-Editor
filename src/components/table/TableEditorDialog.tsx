"use client";

/**
 * TableEditorDialog — full-screen modal that ties the table editor together.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Header: name input + close button                            │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ TableToolbar                                                   │
 *   ├─────────────────────────────────────────┬────────────────────┤
 *   │ TableGrid (flex-1)                       │ RightPanel         │
 *   │                                          │ (collapsible)      │
 *   └──────────────────────────────────────────┴────────────────────┘
 *
 * State (all local — initialized from the store on open):
 *   - draft: TableDoc — the working copy.
 *   - selection / editingCell — grid interaction state.
 *   - rightPanelWidth / rightPanelCollapsed — right panel.
 *   - zoneDialogOpen / editingZone — named-zone CRUD dialog.
 *
 * Side effects:
 *   - Cell edit → debounced 300ms formula re-eval (evaluateTable) →
 *     debounced 500ms save to store (updateTableDoc).
 *   - All structural changes (insert/delete row/col, merge/unmerge,
 *     style patches, zones) → immediately update draft → debounced save.
 *
 * The dialog is mounted only when open (conditional render of the inner
 * content) so useState initializes fresh from the store each open —
 * same pattern as AutoFillXmlEditorDialog.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Table2, X, Save, Pencil, Trash2, Plus, Undo2, Redo2, History } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useEditorStore } from "@/store/editor-store";
import { TableGrid } from "./TableGrid";
import { TableToolbar } from "./TableToolbar";
import { RightPanel } from "./RightPanel";
import { CellLinkDialog } from "./CellLinkDialog";
import { FormulaLinkDialog } from "./FormulaLinkDialog";
import { FormulaCreateDialog, type FormulaCreateType } from "./FormulaCreateDialog";
import { FormulaPreviewBar } from "./FormulaPreviewBar";
import {
  evaluateTable,
} from "@/lib/table/formula-engine";
import { cellsToTSV, tsvToCells } from "@/lib/table/md-converter";
import {
  rewriteFormulaRefs,
  findMergeAt,
  normalizeSelection,
  toCellRef,
  selectionsOverlap,
  letterToCol,
  colToLetter,
} from "@/lib/table/cell-utils";
import type {
  TableDoc,
  Cell,
  CellStyle,
  Selection,
  NamedZone,
  Merge,
} from "@/lib/table/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Adjust relative cell references in a formula by rowDelta/colDelta.
 *  Absolute refs ($A$1) are NOT shifted. Relative refs (A1) shift by delta.
 *  Used by the fill handle to copy formulas with relative reference adjustment. */
function adjustFormulaRefs(formula: string, rowDelta: number, colDelta: number): string {
  if (!formula.startsWith("=")) return formula;
  // Match cell refs: $A$1, A$1, $A1, A1, AA10
  const cellRefRegex = /\$?([A-Z]+)\$?(\d+)/g;
  return formula.replace(cellRefRegex, (match, letters, digits) => {
    const colAbs = match.startsWith("$");
    const lettersIdx = match.indexOf(letters);
    const afterLetters = lettersIdx + letters.length;
    const rowAbs = match.indexOf("$", afterLetters) !== -1;

    const col = letterToCol(letters);
    const row = parseInt(digits, 10) - 1; // 0-indexed

    const newCol = colAbs ? col : col + colDelta;
    const newRow = rowAbs ? row : row + rowDelta;

    if (newRow < 0 || newCol < 0) return match; // don't shift to negative

    return (
      (colAbs ? "$" : "") +
      colToLetter(newCol) +
      (rowAbs ? "$" : "") +
      (newRow + 1)
    );
  });
}

/** A history entry — a snapshot of the draft before a mutation, with a
 *  human-readable description and timestamp. Stored in the undo/redo stacks. */
interface HistoryEntry {
  doc: TableDoc;
  description: string;
  ts: number;
}

/** Format a timestamp as HH:MM:SS for the history modal. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Ensure the cells matrix has at least `rowCount` rows and `colCount` cols,
 *  padding with `null` where needed. Returns a NEW matrix. */
function ensureGridSize(
  cells: (Cell | null)[][],
  rowCount: number,
  colCount: number,
): (Cell | null)[][] {
  const out: (Cell | null)[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: (Cell | null)[] = [];
    const src = cells[r];
    for (let c = 0; c < colCount; c++) {
      row.push(src && c < src.length ? src[c] : null);
    }
    out.push(row);
  }
  return out;
}

/** Get a cell from the grid, returning null for out-of-range or empty. */
function getCell(cells: (Cell | null)[][], r: number, c: number): Cell | null {
  if (r < 0 || r >= cells.length) return null;
  const row = cells[r];
  if (!row || c < 0 || c >= row.length) return null;
  return row[c];
}

/** Set a cell in the grid (immutably). Returns a NEW matrix. */
function setCell(
  cells: (Cell | null)[][],
  r: number,
  c: number,
  cell: Cell | null,
): (Cell | null)[][] {
  const next = cells.map((row) => row.slice());
  while (next.length <= r) next.push([]);
  const row = next[r];
  while (row.length <= c) row.push(null);
  row[c] = cell;
  return next;
}

/** Adjust merges after inserting `count` rows BEFORE `insertRowIdx`. */
function shiftMergesOnRowInsert(
  merges: Merge[],
  insertRowIdx: number,
  count: number,
): Merge[] {
  return merges.map((m) => {
    if (m.row >= insertRowIdx) {
      return { ...m, row: m.row + count };
    }
    if (m.row + m.rowSpan > insertRowIdx) {
      // Merge spans the insertion point — grow it.
      return { ...m, rowSpan: m.rowSpan + count };
    }
    return m;
  });
}

function shiftMergesOnColInsert(
  merges: Merge[],
  insertColIdx: number,
  count: number,
): Merge[] {
  return merges.map((m) => {
    if (m.col >= insertColIdx) {
      return { ...m, col: m.col + count };
    }
    if (m.col + m.colSpan > insertColIdx) {
      return { ...m, colSpan: m.colSpan + count };
    }
    return m;
  });
}

/** Adjust merges after deleting row `deletedRowIdx`. */
function shiftMergesOnRowDelete(merges: Merge[], deletedRowIdx: number): Merge[] {
  const out: Merge[] = [];
  for (const m of merges) {
    const mergeEnd = m.row + m.rowSpan - 1;
    if (deletedRowIdx < m.row) {
      // Deleted row is above the merge → shift merge up.
      out.push({ ...m, row: m.row - 1 });
    } else if (deletedRowIdx > mergeEnd) {
      // Deleted row is below → no change.
      out.push(m);
    } else {
      // Deleted row is inside the merge → shrink it.
      const newRowSpan = m.rowSpan - 1;
      if (newRowSpan < 1) {
        // Merge collapses → drop it.
        continue;
      }
      out.push({ ...m, rowSpan: newRowSpan });
    }
  }
  return out;
}

function shiftMergesOnColDelete(merges: Merge[], deletedColIdx: number): Merge[] {
  const out: Merge[] = [];
  for (const m of merges) {
    const mergeEnd = m.col + m.colSpan - 1;
    if (deletedColIdx < m.col) {
      out.push({ ...m, col: m.col - 1 });
    } else if (deletedColIdx > mergeEnd) {
      out.push(m);
    } else {
      const newColSpan = m.colSpan - 1;
      if (newColSpan < 1) continue;
      out.push({ ...m, colSpan: newColSpan });
    }
  }
  return out;
}

/** Same as merges, but for named zones. */
function shiftZonesOnRowInsert(zones: NamedZone[], idx: number, count: number): NamedZone[] {
  return zones.map((z) => {
    if (z.row >= idx) return { ...z, row: z.row + count };
    if (z.row + z.rowSpan > idx) return { ...z, rowSpan: z.rowSpan + count };
    return z;
  });
}
function shiftZonesOnColInsert(zones: NamedZone[], idx: number, count: number): NamedZone[] {
  return zones.map((z) => {
    if (z.col >= idx) return { ...z, col: z.col + count };
    if (z.col + z.colSpan > idx) return { ...z, colSpan: z.colSpan + count };
    return z;
  });
}
function shiftZonesOnRowDelete(zones: NamedZone[], idx: number): NamedZone[] {
  const out: NamedZone[] = [];
  for (const z of zones) {
    const end = z.row + z.rowSpan - 1;
    if (idx < z.row) {
      out.push({ ...z, row: z.row - 1 });
    } else if (idx > end) {
      out.push(z);
    } else {
      const ns = z.rowSpan - 1;
      if (ns < 1) continue;
      out.push({ ...z, rowSpan: ns });
    }
  }
  return out;
}
function shiftZonesOnColDelete(zones: NamedZone[], idx: number): NamedZone[] {
  const out: NamedZone[] = [];
  for (const z of zones) {
    const end = z.col + z.colSpan - 1;
    if (idx < z.col) {
      out.push({ ...z, col: z.col - 1 });
    } else if (idx > end) {
      out.push(z);
    } else {
      const ns = z.colSpan - 1;
      if (ns < 1) continue;
      out.push({ ...z, colSpan: ns });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function TableEditorDialog() {
  const openId = useEditorStore((s) => s.tableEditorOpenId);
  const tableDocs = useEditorStore((s) => s.tableDocs);
  const updateTableDoc = useEditorStore((s) => s.updateTableDoc);
  const closeTableEditor = useEditorStore((s) => s.closeTableEditor);
  const openDoc = openId ? tableDocs.find((d) => d.id === openId) : null;

  return (
    <Dialog
      open={!!openId && !!openDoc}
      onOpenChange={(o) => {
        if (!o) closeTableEditor();
      }}
    >
      <DialogContent
        className="!fixed !inset-0 !top-0 !left-0 !translate-x-0 !translate-y-0 w-screen h-screen !max-w-none !max-h-none sm:!max-w-none sm:!max-h-none sm:rounded-none flex flex-col p-0 gap-0"
        style={{ zIndex: 9999 }}
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>Редактор таблицы</DialogTitle>
          <DialogDescription>Редактирование таблицы</DialogDescription>
        </VisuallyHidden>
        {openDoc && (
          <TableEditorContent
            key={openDoc.id}
            initialDoc={openDoc}
            onClose={closeTableEditor}
            onSave={updateTableDoc}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Inner content — mounted only when a doc is open, so useState initializes
// fresh from the store on every open.
// ---------------------------------------------------------------------------

interface ContentProps {
  initialDoc: TableDoc;
  onClose: () => void;
  onSave: (id: string, patch: Partial<TableDoc>) => void;
}

function TableEditorContent({ initialDoc, onClose, onSave }: ContentProps) {
  // ---- Store actions (cell link integration) ----
  const createCellLink = useEditorStore((s) => s.createCellLink);
  const deleteCellLink = useEditorStore((s) => s.deleteCellLink);
  const syncCellLinksToAutoFill = useEditorStore((s) => s.syncCellLinksToAutoFill);
  // ---- Store actions (formula link integration) ----
  const createFormulaLink = useEditorStore((s) => s.createFormulaLink);
  const deleteFormulaLink = useEditorStore((s) => s.deleteFormulaLink);
  const syncCellLinksToFormulas = useEditorStore((s) => s.syncCellLinksToFormulas);
  const pushFormulaValuesToCells = useEditorStore((s) => s.pushFormulaValuesToCells);
  const createFormulaFromTable = useEditorStore((s) => s.createFormulaFromTable);
  const recalcAndSyncFormulas = useEditorStore((s) => s.recalcAndSyncFormulas);
  const formulaStore = useEditorStore((s) => s.formulaStore);

  // ---- Draft state ----
  const [draft, setDraft] = useState<TableDoc>(() => ({
    ...initialDoc,
    cells: ensureGridSize(initialDoc.cells, initialDoc.rowCount, initialDoc.colCount),
  }));
  const [selection, setSelection] = useState<Selection>({
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
  });
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  /** When set, editing started via direct typing — the char pre-fills the cell. */
  const [editInitialChar, setEditInitialChar] = useState<string | null>(null);

  // Right panel
  const [panelWidth, setPanelWidth] = useState(500);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  /** Ref to the TableGrid's scroll container — captured via containerRefCallback
   *  and passed to RightPanel for sync-scroll. */
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  // Zone dialog
  const [zoneDialogOpen, setZoneDialogOpen] = useState(false);
  const [editingZone, setEditingZone] = useState<NamedZone | null>(null);
  const [zoneForm, setZoneForm] = useState<{ name: string; description: string }>({
    name: "",
    description: "",
  });

  // Cell-link dialog (Link to AutoFill)
  const [cellLinkDialogOpen, setCellLinkDialogOpen] = useState(false);
  const [cellPicking, setCellPicking] = useState(false);
  const [pickedCell, setPickedCell] = useState<{ row: number; col: number } | null>(null);
  /** Initial coordinate text for CellLinkDialog (range or single cell). */
  const [cellLinkInitialCoord, setCellLinkInitialCoord] = useState<string>("");

  // Formula-link dialog (f button) — link cell to calculator formula/constant.
  const [formulaLinkDialogOpen, setFormulaLinkDialogOpen] = useState(false);
  const [formulaLinkPicking, setFormulaLinkPicking] = useState(false);
  const [formulaLinkPickedCell, setFormulaLinkPickedCell] = useState<{ row: number; col: number } | null>(null);
  const [formulaLinkInitialCoord, setFormulaLinkInitialCoord] = useState<string>("");

  // Formula-create dialog (f+ button) — create new formula/constant/matrix.
  const [formulaCreateDialogOpen, setFormulaCreateDialogOpen] = useState(false);
  const [formulaCreatePicking, setFormulaCreatePicking] = useState(false);
  const [formulaCreatePickedCell, setFormulaCreatePickedCell] = useState<{ row: number; col: number } | null>(null);

  // Refs to avoid stale closures in debounced timers.
  const draftRef = useRef(draft);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Inner timer for pushFormulaValuesToCells (scheduled inside scheduleEval). */
  const evalInnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Signature of the last-seen formula values — used to skip redundant
   *  useEffect([formulaStore]) firings when only the reference changed. */
  const lastFormulaSigRef = useRef<string>("");
  const rawDirtyRef = useRef(false);

  // ---- Undo / Redo journal ----
  // Each entry stores the PREVIOUS draft (before the mutation). pushUndo is
  // called at the start of every mutation handler to capture the current
  // draftRef.current. handleUndo pops the last entry and restores its doc.
  // Max 50 entries (oldest are shifted out).
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Keep draftRef in sync (must be inside an effect, not during render).
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  /** Capture the current draft as a history entry before applying a mutation.
   *  Deduplicates by reference: if the current draft is the same reference as
   *  the last pushed entry (happens when multiple mutations are batched
   *  synchronously, e.g. Delete-on-selection calls handleCellEdit in a loop),
   *  skip pushing so the user only has to press Ctrl+Z once. */
  const pushUndo = useCallback((description: string) => {
    const currentDoc = draftRef.current;
    setUndoStack((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.doc === currentDoc) {
        // Same doc reference as the last entry → skip the duplicate.
        return prev;
      }
      const next = [...prev, { doc: currentDoc, description, ts: Date.now() }];
      if (next.length > 50) next.shift();
      return next;
    });
    setRedoStack([]);
  }, []);

  /** Undo the last mutation: pop from undoStack, push current draft to
   *  redoStack, restore the popped doc. */
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    const currentDoc = draftRef.current;
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((r) => [...r, {
      doc: currentDoc,
      description: last.description,
      ts: last.ts,
    }]);
    setDraft(last.doc);
  }, [undoStack]);

  /** Redo the last undone mutation: pop from redoStack, push current draft
   *  to undoStack, restore the popped doc. */
  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const last = redoStack[redoStack.length - 1];
    const currentDoc = draftRef.current;
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((u) => [...u, {
      doc: currentDoc,
      description: last.description,
      ts: last.ts,
    }]);
    setDraft(last.doc);
  }, [redoStack]);

  /** Restore the draft to the state captured at history entry `index`
   *  (0 = oldest, length-1 = newest). Simulates undoing (length - index)
   *  times: truncates the undo stack, pushes the in-between docs onto the
   *  redo stack so the user can Ctrl+Y back to the present. */
  const handleRestoreFromHistory = useCallback((index: number) => {
    const stack = undoStack;
    if (index < 0 || index >= stack.length) return;
    const targetEntry = stack[index];
    const currentDoc = draftRef.current;

    // Build the redo entries that would have been pushed if we had undone
    // step-by-step from the current state down to `index`.
    // Order: oldest-first (the first push becomes the deepest redo entry).
    const steps = stack.length - index;
    const newRedoEntries: HistoryEntry[] = [];
    for (let k = 0; k < steps; k++) {
      const undoIdx = stack.length - 1 - k; // stack[last], stack[last-1], ...
      const undoEntry = stack[undoIdx];
      // When undoing undoEntry, the doc pushed to redo is the state we're
      // currently in. For the first step (k=0) that's `currentDoc`; for
      // later steps it's the previous (deeper) undo entry's doc.
      const docToPush = k === 0 ? currentDoc : stack[undoIdx + 1].doc;
      newRedoEntries.push({
        doc: docToPush,
        description: undoEntry.description,
        ts: undoEntry.ts,
      });
    }

    setUndoStack(stack.slice(0, index));
    setRedoStack((r) => [...r, ...newRedoEntries]);
    setDraft(targetEntry.doc);
    setHistoryOpen(false);
  }, [undoStack]);

  // ---- Global Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z hotkeys (layout-independent) ----
  // Uses e.code (physical key) so the hotkeys work on ANY keyboard layout.
  // Skipped while editing a cell so the input's native undo can run.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (editingCell) return; // let the cell input's native undo work
      if (e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleUndo, handleRedo, editingCell]);

  // ---- Debounced save to store (500ms) ----
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const d = draftRef.current;
      onSave(d.id, {
        name: d.name,
        cells: d.cells,
        merges: d.merges,
        zones: d.zones,
        colWidths: d.colWidths,
        rowHeights: d.rowHeights,
        rowCount: d.rowCount,
        colCount: d.colCount,
      });
    }, 500);
  }, [onSave]);

  // Schedule save whenever draft changes.
  useEffect(() => {
    scheduleSave();
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [draft, scheduleSave]);

  // Cleanup on unmount: flush pending save.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        const d = draftRef.current;
        onSave(d.id, {
          name: d.name,
          cells: d.cells,
          merges: d.merges,
          zones: d.zones,
          colWidths: d.colWidths,
          rowHeights: d.rowHeights,
          rowCount: d.rowCount,
          colCount: d.colCount,
        });
      }
    };
  }, [onSave]);

  // ---- Debounced formula re-eval (300ms after raw-value change) ----
  // After evaluation, push the evaluated cells to the store immediately so
  // that syncCellLinksToAutoFill sees the latest computed values, then call
  // syncCellLinksToAutoFill to propagate linked cell values → AF fields.
  // Also sync formula links: cell values → calculator FormulaStore, then
  // recalc all formulas, then push formula values back to function cells.
  const scheduleEval = useCallback(() => {
    if (evalTimerRef.current) clearTimeout(evalTimerRef.current);
    if (evalInnerTimerRef.current) clearTimeout(evalInnerTimerRef.current);
    evalTimerRef.current = setTimeout(() => {
      const d = draftRef.current;
      const evaluated = evaluateTable(d.cells);
      rawDirtyRef.current = false;
      setDraft((prev) => ({ ...prev, cells: evaluated }));
      // Push evaluated cells to the store right away (so the sync reads
      // fresh values instead of waiting for the 500ms save timer).
      onSave(d.id, { cells: evaluated });
      // Propagate linked cell values → auto-fill fields.
      syncCellLinksToAutoFill(d.id);
      // Propagate linked cell values → calculator FormulaStore (constants +
      // matrices). This triggers recalcAndSyncFormulas internally.
      syncCellLinksToFormulas(d.id);
      // After recalc, push formula values back to function cells (read-only).
      // Tracked in evalInnerTimerRef so it can be cancelled on unmount.
      evalInnerTimerRef.current = setTimeout(() => {
        const newCells = pushFormulaValuesToCells(d.id);
        if (newCells) {
          setDraft((prev) => ({ ...prev, cells: newCells }));
        }
      }, 50);
    }, 300);
  }, [onSave, syncCellLinksToAutoFill, syncCellLinksToFormulas, pushFormulaValuesToCells]);

  // On mount: trigger a formula re-evaluation so that computed values are
  // up to date (e.g. when a cell was changed externally via the XML editor
  // or reverse sync, the formula cells need to recalculate).
  // Cleanup: clear both timers on unmount to prevent state updates on an
  // unmounted component and timer leaks.
  useEffect(() => {
    scheduleEval();
    return () => {
      if (evalTimerRef.current) clearTimeout(evalTimerRef.current);
      if (evalInnerTimerRef.current) clearTimeout(evalInnerTimerRef.current);
    };
  }, [scheduleEval]);

  // ---- Cell editing ----
  const handleCellEdit = useCallback(
    (row: number, col: number, raw: string) => {
      // No-op check BEFORE pushUndo so we don't pollute the journal with
      // entries for edits that didn't change anything (e.g. committing an
      // unchanged cell via Tab, or clearing already-empty cells in a
      // Delete-on-selection loop).
      const existing = getCell(draftRef.current.cells, row, col);
      if (existing && existing.raw === raw) return;
      pushUndo(`Edit cell ${toCellRef(row, col)}`);
      setDraft((prev) => {
        const ex = getCell(prev.cells, row, col);
        // Defensive no-op check inside the updater too.
        if (ex && ex.raw === raw) return prev;
        const newCell: Cell | null = raw === "" ? null : { ...ex, raw, computed: ex?.computed ?? null };
        const cells = setCell(prev.cells, row, col, newCell);
        return { ...prev, cells };
      });
      rawDirtyRef.current = true;
      scheduleEval();
    },
    [scheduleEval, pushUndo],
  );

  // ---- Fill handle: copy/fill cells from source to target range ----
  // For plain values: copy the value to each target cell.
  // For formulas: copy with relative reference adjustment (row/col delta).
  // Absolute refs ($A$1) are preserved; relative refs (A1) shift by the delta.
  const handleFillComplete = useCallback(
    (sourceSel: Selection, targetSel: Selection) => {
      pushUndo(`Fill ${toCellRef(sourceSel.startRow, sourceSel.startCol)}→${toCellRef(targetSel.endRow, targetSel.endCol)}`);
      setDraft((prev) => {
        const cells = prev.cells.map((r) => r.slice());
        const srcHeight = sourceSel.endRow - sourceSel.startRow + 1;
        const srcWidth = sourceSel.endCol - sourceSel.startCol + 1;

        // For each target cell, find the corresponding source cell and copy it
        for (let r = targetSel.startRow; r <= targetSel.endRow; r++) {
          for (let c = targetSel.startCol; c <= targetSel.endCol; c++) {
            // Skip cells inside the source range (they stay as-is)
            if (r >= sourceSel.startRow && r <= sourceSel.endRow &&
                c >= sourceSel.startCol && c <= sourceSel.endCol) continue;

            // Find the corresponding source cell (cyclic pattern for small sources)
            const srcRow = sourceSel.startRow + ((r - targetSel.startRow) % srcHeight + srcHeight) % srcHeight;
            const srcCol = sourceSel.startCol + ((c - targetSel.startCol) % srcWidth + srcWidth) % srcWidth;
            const srcCell = getCell(prev.cells, srcRow, srcCol);
            if (!srcCell) continue;

            // Calculate the row/col delta for formula reference adjustment
            const rowDelta = r - srcRow;
            const colDelta = c - srcCol;

            let newRaw = srcCell.raw;
            // If the cell is a formula, adjust relative cell references
            if (srcCell.raw.startsWith("=")) {
              newRaw = adjustFormulaRefs(srcCell.raw, rowDelta, colDelta);
            }

            // Copy the cell, but DO NOT copy linkId — only the original cell
            // keeps the auto-fill link. Copies get plain values/formulas.
            // Also remove link-specific style (fillColor, fontColor, bold).
            const { linkId: _lid, style: srcStyle, ...cellRest } = srcCell;
            const copyStyle = srcStyle ? { ...srcStyle } : undefined;
            if (copyStyle) {
              delete copyStyle.fillColor;
              delete copyStyle.fontColor;
              delete copyStyle.bold;
            }
            const newCell: Cell = {
              ...cellRest,
              raw: newRaw,
              computed: null,
              error: undefined,
              style: copyStyle && Object.keys(copyStyle).length > 0 ? copyStyle : undefined,
              // linkId intentionally NOT set
            };
            while (cells.length <= r) cells.push([]);
            const row = cells[r];
            while (row.length <= c) row.push(null);
            row[c] = newCell;
          }
        }
        return { ...prev, cells };
      });
      rawDirtyRef.current = true;
      scheduleEval();
      // Update selection to the filled range
      setSelection(targetSel);
    },
    [scheduleEval, pushUndo],
  );

  // ---- Apply style to selection ----
  // The style of the primary selected cell — used by the toolbar to show
  // toggle button states (B/I/U/S pressed, alignment, etc.).
  const activeCellStyle = useMemo(() => {
    const cell = getCell(draft.cells, selection.startRow, selection.startCol);
    return cell?.style ?? {};
  }, [draft.cells, selection.startRow, selection.startCol]);

  const handleApplyStyle = useCallback((patch: Partial<CellStyle>) => {
    // Build a human-readable description of the patch for the journal.
    const styleKeys = Object.keys(patch).filter((k) => patch[k as keyof CellStyle] !== undefined);
    const styleName = styleKeys.length > 0 ? styleKeys.join(", ") : "style";
    const norm = normalizeSelection(selection);
    const rangeStr =
      norm.startRow === norm.endRow && norm.startCol === norm.endCol
        ? toCellRef(norm.startRow, norm.startCol)
        : `${toCellRef(norm.startRow, norm.startCol)}:${toCellRef(norm.endRow, norm.endCol)}`;
    pushUndo(`Apply ${styleName} to ${rangeStr}`);
    // Toggle logic for boolean styles: if the primary cell already has the
    // style set to the same value, toggle it off.
    const toggleKeys: (keyof CellStyle)[] = ["bold", "italic", "underline", "strikethrough"];
    const adjustedPatch: Partial<CellStyle> = { ...patch };
    for (const key of toggleKeys) {
      if (key in patch && patch[key] === true) {
        const current = getCell(draftRef.current.cells, selection.startRow, selection.startCol);
        if (current?.style?.[key]) {
          adjustedPatch[key] = false;
        }
      }
    }
    setDraft((prev) => {
      const cells = prev.cells.map((row) => row.slice());
      for (let r = norm.startRow; r <= norm.endRow; r++) {
        for (let c = norm.startCol; c <= norm.endCol; c++) {
          const merge = findMergeAt(r, c, prev.merges);
          if (merge && (merge.row !== r || merge.col !== c)) continue;
          const ex = getCell(cells, r, c);
          const newStyle: CellStyle = { ...(ex?.style ?? {}), ...adjustedPatch };
          (Object.keys(newStyle) as (keyof CellStyle)[]).forEach((k) => {
            if (newStyle[k] === undefined) delete newStyle[k];
          });
          const newCell: Cell = ex
            ? { ...ex, style: newStyle }
            : { raw: "", computed: null, style: newStyle };
          while (cells.length <= r) cells.push([]);
          const rr = cells[r];
          while (rr.length <= c) rr.push(null);
          rr[c] = newCell;
        }
      }
      return { ...prev, cells };
    });
  }, [selection, pushUndo]);

  // ---- Merge / Unmerge ----
  const handleMerge = useCallback(() => {
    const norm = normalizeSelection(selection);
    const rangeStr =
      norm.startRow === norm.endRow && norm.startCol === norm.endCol
        ? toCellRef(norm.startRow, norm.startCol)
        : `${toCellRef(norm.startRow, norm.startCol)}:${toCellRef(norm.endRow, norm.endCol)}`;
    pushUndo(`Merge cells ${rangeStr}`);
    setDraft((prev) => {
      const rowSpan = norm.endRow - norm.startRow + 1;
      const colSpan = norm.endCol - norm.startCol + 1;
      // If selection is already a single cell, do nothing.
      if (rowSpan === 1 && colSpan === 1) return prev;
      // Remove existing merges that overlap the selection.
      const selRect: Selection = norm;
      const filtered = prev.merges.filter((m) => {
        const mRect: Selection = {
          startRow: m.row,
          startCol: m.col,
          endRow: m.row + m.rowSpan - 1,
          endCol: m.col + m.colSpan - 1,
        };
        return !selectionsOverlap(selRect, mRect);
      });
      const newMerge: Merge = {
        row: norm.startRow,
        col: norm.startCol,
        rowSpan,
        colSpan,
      };
      return { ...prev, merges: [...filtered, newMerge] };
    });
  }, [selection, pushUndo]);

  const handleUnmerge = useCallback(() => {
    const norm = normalizeSelection(selection);
    const rangeStr =
      norm.startRow === norm.endRow && norm.startCol === norm.endCol
        ? toCellRef(norm.startRow, norm.startCol)
        : `${toCellRef(norm.startRow, norm.startCol)}:${toCellRef(norm.endRow, norm.endCol)}`;
    pushUndo(`Unmerge cells ${rangeStr}`);
    setDraft((prev) => {
      const filtered = prev.merges.filter((m) => {
        const mRect: Selection = {
          startRow: m.row,
          startCol: m.col,
          endRow: m.row + m.rowSpan - 1,
          endCol: m.col + m.colSpan - 1,
        };
        return !selectionsOverlap(norm, mRect);
      });
      return { ...prev, merges: filtered };
    });
  }, [selection, pushUndo]);

  // ---- Insert / Delete row ----
  const handleInsertRow = useCallback(
    (row: number, count: number) => {
      pushUndo(`Insert row at ${row + 1}`);
      setDraft((prev) => {
        // 1. Rewrite formula refs in all cells (rows > row shift down by count).
        const cells = prev.cells.map((rowArr, r) =>
          rowArr.map((cell) => {
            if (!cell || !cell.raw.startsWith("=")) return cell;
            const newRaw = rewriteFormulaRefs(cell.raw, row, -1, count);
            return { ...cell, raw: newRaw };
          }),
        );
        // 2. Insert empty rows at position `row`.
        const newRows: (Cell | null)[][] = [];
        for (let i = 0; i < count; i++) {
          newRows.push(new Array(prev.colCount).fill(null));
        }
        const next = [...cells.slice(0, row), ...newRows, ...cells.slice(row)];
        // 3. Adjust merges + zones.
        const merges = shiftMergesOnRowInsert(prev.merges, row, count);
        const zones = shiftZonesOnRowInsert(prev.zones, row, count);
        return {
          ...prev,
          cells: next,
          merges,
          zones,
          rowCount: prev.rowCount + count,
        };
      });
      rawDirtyRef.current = true;
      scheduleEval();
    },
    [scheduleEval, pushUndo],
  );

  const handleInsertCol = useCallback(
    (col: number, count: number) => {
      pushUndo(`Insert column at ${col + 1}`);
      setDraft((prev) => {
        const cells = prev.cells.map((rowArr) => {
          // Rewrite formula refs for this row's cells.
          const rewritten = rowArr.map((cell) => {
            if (!cell || !cell.raw.startsWith("=")) return cell;
            const newRaw = rewriteFormulaRefs(cell.raw, -1, col, count);
            return { ...cell, raw: newRaw };
          });
          // Insert `count` empty cells at position `col`.
          const empties: (Cell | null)[] = new Array(count).fill(null);
          return [...rewritten.slice(0, col), ...empties, ...rewritten.slice(col)];
        });
        const merges = shiftMergesOnColInsert(prev.merges, col, count);
        const zones = shiftZonesOnColInsert(prev.zones, col, count);
        return {
          ...prev,
          cells,
          merges,
          zones,
          colCount: prev.colCount + count,
        };
      });
      rawDirtyRef.current = true;
      scheduleEval();
    },
    [scheduleEval, pushUndo],
  );

  const handleDeleteRow = useCallback(
    (row: number) => {
      if (draftRef.current.rowCount <= 1) return;
      pushUndo(`Delete row ${row + 1}`);
      setDraft((prev) => {
        if (prev.rowCount <= 1) return prev;
        // 1. Rewrite formula refs: rows > row shift up by 1.
        const cells = prev.cells
          .filter((_, r) => r !== row)
          .map((rowArr) =>
            rowArr.map((cell) => {
              if (!cell || !cell.raw.startsWith("=")) return cell;
              const newRaw = rewriteFormulaRefs(cell.raw, row, -1, -1);
              return { ...cell, raw: newRaw };
            }),
          );
        const merges = shiftMergesOnRowDelete(prev.merges, row);
        const zones = shiftZonesOnRowDelete(prev.zones, row);
        return {
          ...prev,
          cells,
          merges,
          zones,
          rowCount: prev.rowCount - 1,
        };
      });
      rawDirtyRef.current = true;
      scheduleEval();
    },
    [scheduleEval, pushUndo],
  );

  const handleDeleteCol = useCallback(
    (col: number) => {
      if (draftRef.current.colCount <= 1) return;
      pushUndo(`Delete column ${col + 1}`);
      setDraft((prev) => {
        if (prev.colCount <= 1) return prev;
        const cells = prev.cells.map((rowArr) => {
          const filtered = rowArr.filter((_, c) => c !== col);
          return filtered.map((cell) => {
            if (!cell || !cell.raw.startsWith("=")) return cell;
            const newRaw = rewriteFormulaRefs(cell.raw, -1, col, -1);
            return { ...cell, raw: newRaw };
          });
        });
        const merges = shiftMergesOnColDelete(prev.merges, col);
        const zones = shiftZonesOnColDelete(prev.zones, col);
        return {
          ...prev,
          cells,
          merges,
          zones,
          colCount: prev.colCount - 1,
        };
      });
      rawDirtyRef.current = true;
      scheduleEval();
    },
    [scheduleEval, pushUndo],
  );

  // ---- Clipboard (Ctrl+C/X/V) — layout-independent via e.code ----
  const handleClipboard = useCallback(
    async (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Use e.code (physical key) so hotkeys work on ANY keyboard layout.
      const code = e.code;
      if (code !== "KeyC" && code !== "KeyX" && code !== "KeyV") return;
      // Only handle when not editing a cell.
      if (editingCell) return;

      e.preventDefault();
      const d = draftRef.current;
      const norm = normalizeSelection(selection);

      if (code === "KeyC" || code === "KeyX") {
        // Build a 2D array of cells for the selection.
        const sub: (Cell | null)[][] = [];
        for (let r = norm.startRow; r <= norm.endRow; r++) {
          const row: (Cell | null)[] = [];
          for (let c = norm.startCol; c <= norm.endCol; c++) {
            row.push(getCell(d.cells, r, c));
          }
          sub.push(row);
        }
        const tsv = cellsToTSV(sub);
        try {
          await navigator.clipboard.writeText(tsv);
        } catch {
          toast.error("Не удалось скопировать в буфер обмена");
          return;
        }
        if (code === "KeyX") {
          for (let r = norm.startRow; r <= norm.endRow; r++) {
            for (let c = norm.startCol; c <= norm.endCol; c++) {
              handleCellEdit(r, c, "");
            }
          }
          toast.success("Вырезано");
        } else {
          toast.success("Скопировано");
        }
        return;
      }

      // Paste (code === "KeyV")
      let tsv = "";
      try {
        tsv = await navigator.clipboard.readText();
      } catch {
        toast.error("Не удалось прочитать буфер обмена");
        return;
      }
      const parsed = tsvToCells(tsv);
      if (parsed.length === 0) return;
      pushUndo(`Paste to ${toCellRef(norm.startRow, norm.startCol)}`);
      setDraft((prev) => {
        const cells = prev.cells.map((row) => row.slice());
        const neededRows = norm.startRow + parsed.length;
        const neededCols = norm.startCol + Math.max(...parsed.map((r) => r.length));
        while (cells.length < neededRows) cells.push(new Array(prev.colCount).fill(null));
        for (let i = 0; i < parsed.length; i++) {
          for (let j = 0; j < parsed[i].length; j++) {
            const r = norm.startRow + i;
            const c = norm.startCol + j;
            while (cells[r].length <= c) cells[r].push(null);
            const raw = parsed[i][j];
            cells[r][c] = raw === "" ? null : { raw, computed: null };
          }
        }
        return {
          ...prev,
          cells,
          rowCount: Math.max(prev.rowCount, neededRows),
          colCount: Math.max(prev.colCount, neededCols),
        };
      });
      rawDirtyRef.current = true;
      scheduleEval();
      toast.success("Вставлено");
    },
    [editingCell, selection, handleCellEdit, scheduleEval, pushUndo],
  );

  // Attach clipboard listener to document.
  useEffect(() => {
    window.addEventListener("keydown", handleClipboard);
    return () => window.removeEventListener("keydown", handleClipboard);
  }, [handleClipboard]);

  // ---- Capture printable char for direct typing ----
  // When the grid's handleKeyDown triggers editing via a printable char,
  // we capture that char here so the edit input starts with it pre-filled
  // instead of the old cell value.
  const handleEditingCellChange = useCallback(
    (cell: { row: number; col: number } | null) => {
      if (cell && !editingCell) {
        // Starting a new edit — check if there's a pending char from the keydown.
        // The char was set by the capture-phase listener below.
        // editInitialChar will be cleared after the CellEditInput mounts.
      }
      setEditingCell(cell);
      if (!cell) setEditInitialChar(null);
    },
    [editingCell],
  );

  // Capture-phase listener: when a printable key is pressed and we're not
  // editing, record the char so handleEditingCellChange can use it.
  useEffect(() => {
    const captureChar = (e: KeyboardEvent) => {
      if (editingCell) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Only single printable chars
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setEditInitialChar(e.key);
        // Clear it after a tick so it doesn't persist for double-click edits.
        setTimeout(() => setEditInitialChar(null), 100);
      }
    };
    window.addEventListener("keydown", captureChar, true); // capture phase
    return () => window.removeEventListener("keydown", captureChar, true);
  }, [editingCell]);

  // ---- Name editing ----
  const handleNameChange = useCallback((name: string) => {
    setDraft((prev) => ({ ...prev, name }));
  }, []);

  // ---- Save & close ----
  const handleClose = useCallback(() => {
    // Flush pending save immediately.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const d = draftRef.current;
    onSave(d.id, {
      name: d.name,
      cells: d.cells,
      merges: d.merges,
      zones: d.zones,
      colWidths: d.colWidths,
      rowHeights: d.rowHeights,
      rowCount: d.rowCount,
      colCount: d.colCount,
    });
    onClose();
  }, [onClose, onSave]);

  // ---- Zones CRUD ----
  const handleOpenCreateZone = useCallback(() => {
    setEditingZone(null);
    setZoneForm({ name: "", description: "" });
    setZoneDialogOpen(true);
  }, []);

  const handleEditZone = useCallback((z: NamedZone) => {
    setEditingZone(z);
    setZoneForm({ name: z.name, description: z.description });
    setZoneDialogOpen(true);
  }, []);

  const handleDeleteZone = useCallback((zoneId: string) => {
    const z = draftRef.current.zones.find((zz) => zz.id === zoneId);
    pushUndo(`Delete zone "${z?.name ?? "?"}"`);
    setDraft((prev) => ({
      ...prev,
      zones: prev.zones.filter((zz) => zz.id !== zoneId),
    }));
    toast.success("Зона удалена");
  }, [pushUndo]);

  const handleSaveZone = useCallback(() => {
    const norm = normalizeSelection(selection);
    const rowSpan = norm.endRow - norm.startRow + 1;
    const colSpan = norm.endCol - norm.startCol + 1;
    if (!zoneForm.name.trim()) {
      toast.error("Введите имя зоны");
      return;
    }
    pushUndo(editingZone ? `Update zone "${zoneForm.name.trim()}"` : `Create zone "${zoneForm.name.trim()}"`);
    setDraft((prev) => {
      if (editingZone) {
        return {
          ...prev,
          zones: prev.zones.map((z) =>
            z.id === editingZone.id
              ? {
                  ...z,
                  name: zoneForm.name.trim(),
                  description: zoneForm.description,
                  row: norm.startRow,
                  col: norm.startCol,
                  rowSpan,
                  colSpan,
                }
              : z,
          ),
        };
      }
      const newZone: NamedZone = {
        id: `Z${Date.now().toString(36)}`,
        name: zoneForm.name.trim(),
        description: zoneForm.description,
        row: norm.startRow,
        col: norm.startCol,
        rowSpan,
        colSpan,
      };
      return { ...prev, zones: [...prev.zones, newZone] };
    });
    setZoneDialogOpen(false);
    toast.success(editingZone ? "Зона обновлена" : "Зона создана");
  }, [editingZone, selection, zoneForm, pushUndo]);

  // ---- Derived: selection summary ----
  const selectionRef = useMemo(
    () => toCellRef(selection.startRow, selection.startCol),
    [selection.startRow, selection.startCol],
  );
  const selectionRange = useMemo(() => {
    const norm = normalizeSelection(selection);
    if (norm.startRow === norm.endRow && norm.startCol === norm.endCol) {
      return toCellRef(norm.startRow, norm.startCol);
    }
    return `${toCellRef(norm.startRow, norm.startCol)}:${toCellRef(norm.endRow, norm.endCol)}`;
  }, [selection]);

  // Memoized selection range object for the FormulaCreateDialog prop.
  // MUST be referentially stable across re-renders (as long as the selection
  // hasn't actually changed) — otherwise the dialog's open-effect re-fires on
  // every parent re-render and resets the user's in-progress input.
  const selectionRangeObj = useMemo(() => {
    const norm = normalizeSelection(selection);
    return {
      startRow: norm.startRow,
      startCol: norm.startCol,
      endRow: norm.endRow,
      endCol: norm.endCol,
    };
  }, [selection]);

  // ---- Cell link (Link to AutoFill) handlers ----
  /** Read the latest table doc from the store back into the local draft.
   *  Used after createCellLink / deleteCellLink so the draft reflects the
   *  store mutation (cell.linkId assignment, cellLinks / rightPanelBlocks
   *  changes). Callers MUST push the current draft to the store BEFORE
   *  mutating the store, so this read-back doesn't lose unsaved edits. */
  const refreshDraftFromStore = useCallback(() => {
    const updated = useEditorStore.getState().tableDocs.find(
      (t) => t.id === draftRef.current.id,
    );
    if (updated) {
      setDraft({
        ...updated,
        cells: ensureGridSize(updated.cells, updated.rowCount, updated.colCount),
      });
    }
  }, []);

  const handleOpenCellLinkDialog = useCallback(() => {
    // Pre-fill with the current selection range.
    // If start == end, it's a single cell; otherwise format as range.
    const norm = normalizeSelection(selection);
    const startRef = toCellRef(norm.startRow, norm.startCol);
    const endRef = toCellRef(norm.endRow, norm.endCol);
    const coord = (norm.startRow === norm.endRow && norm.startCol === norm.endCol)
      ? startRef
      : `${startRef}:${endRef}`;
    setCellLinkInitialCoord(coord);
    setPickedCell({ row: norm.startRow, col: norm.startCol });
    setCellPicking(false);
    setCellLinkDialogOpen(true);
  }, [selection]);

  const handleCloseCellLinkDialog = useCallback(() => {
    setCellLinkDialogOpen(false);
    setCellPicking(false);
    setPickedCell(null);
  }, []);

  const handlePickCell = useCallback((row: number, col: number) => {
    setPickedCell({ row, col });
    setCellPicking(false);
  }, []);

  /** Push the current draft's structural fields to the store. Used before
   *  createCellLink / deleteCellLink so the store sees the latest cell
   *  values when it mutates them. */
  const flushDraftToStore = useCallback(() => {
    const d = draftRef.current;
    onSave(d.id, {
      name: d.name,
      cells: d.cells,
      merges: d.merges,
      zones: d.zones,
      colWidths: d.colWidths,
      rowHeights: d.rowHeights,
      rowCount: d.rowCount,
      colCount: d.colCount,
    });
  }, [onSave]);

  const handleCreateCellLink = useCallback(
    (cells: Array<{ row: number; col: number }>, label: string, description: string) => {
      // Flush the draft first so the store has the latest cell values
      // before createCellLink snapshots them into the AF field.
      flushDraftToStore();
      // Create ONE link for the entire range — a single CellLink record
      // with cellIds covering every selected cell, ONE RightPanelBlock,
      // and ONE AutoFillField whose `variants` = all cell values.
      createCellLink(draftRef.current.id, cells, label, description);
      // Sync the AF field values from the linked cells
      syncCellLinksToAutoFill(draftRef.current.id);
      // Trigger a formula re-eval so computed values are up to date
      scheduleEval();
      refreshDraftFromStore();
      setCellLinkDialogOpen(false);
      setCellPicking(false);
      setPickedCell(null);
      if (cells.length > 1) {
        const first = toCellRef(cells[0].row, cells[0].col);
        const last = toCellRef(cells[cells.length - 1].row, cells[cells.length - 1].col);
        toast.success(`Создана связь с диапазоном ${first}:${last} (${cells.length} ячеек)`);
      } else {
        toast.success(`Связь создана: ячейка ${toCellRef(cells[0].row, cells[0].col)}`);
      }
    },
    [flushDraftToStore, createCellLink, syncCellLinksToAutoFill, scheduleEval, refreshDraftFromStore],
  );

  const handleDeleteCellLink = useCallback(
    (linkId: string) => {
      // Flush the draft first so the store has the latest cell values
      // (including linkId) before deleteCellLink clears them.
      flushDraftToStore();
      deleteCellLink(draftRef.current.id, linkId);
      refreshDraftFromStore();
      toast.success("Связь удалена");
    },
    [flushDraftToStore, deleteCellLink, refreshDraftFromStore],
  );

  // ---- Formula link dialog (f button) handlers ----
  const handleOpenFormulaLinkDialog = useCallback(() => {
    // Pre-fill with the current selection.
    const norm = normalizeSelection(selection);
    const coord = (norm.startRow === norm.endRow && norm.startCol === norm.endCol)
      ? toCellRef(norm.startRow, norm.startCol)
      : `${toCellRef(norm.startRow, norm.startCol)}:${toCellRef(norm.endRow, norm.endCol)}`;
    setFormulaLinkInitialCoord(coord);
    setFormulaLinkPickedCell({ row: norm.startRow, col: norm.startCol });
    setFormulaLinkPicking(false);
    setFormulaLinkDialogOpen(true);
  }, [selection]);

  const handleCloseFormulaLinkDialog = useCallback(() => {
    setFormulaLinkDialogOpen(false);
    setFormulaLinkPicking(false);
    setFormulaLinkPickedCell(null);
  }, []);

  const handleFormulaLinkPickCell = useCallback((row: number, col: number) => {
    setFormulaLinkPickedCell({ row, col });
    setFormulaLinkPicking(false);
  }, []);

  /** Simple scenario: link a cell to a CONSTANT. */
  const handleLinkConstant = useCallback(
    (cell: { row: number; col: number }, formulaId: string) => {
      flushDraftToStore();
      const linkId = createFormulaLink(
        draftRef.current.id,
        [cell],
        formulaId,
        "",
        "",
      );
      if (linkId) {
        scheduleEval();
        refreshDraftFromStore();
        toast.success(`Ячейка ${toCellRef(cell.row, cell.col)} связана с константой`);
      }
      setFormulaLinkDialogOpen(false);
      setFormulaLinkPicking(false);
      setFormulaLinkPickedCell(null);
    },
    [flushDraftToStore, createFormulaLink, scheduleEval, refreshDraftFromStore],
  );

  /** Complex scenario: link a cell to a FUNCTION + its dependencies. */
  const handleLinkFunction = useCallback(
    (
      cell: { row: number; col: number },
      formulaId: string,
      dependencies: Array<{ formulaId: string; cell: { row: number; col: number } }>,
    ) => {
      flushDraftToStore();
      // Create constant links for each dependency first.
      for (const dep of dependencies) {
        createFormulaLink(
          draftRef.current.id,
          [dep.cell],
          dep.formulaId,
          "",
          "",
        );
      }
      // Then create the function link.
      const linkId = createFormulaLink(
        draftRef.current.id,
        [cell],
        formulaId,
        "",
        "",
      );
      if (linkId) {
        scheduleEval();
        refreshDraftFromStore();
        toast.success(
          `Создана связь с функцией (${dependencies.length + 1} связей)`,
        );
      }
      setFormulaLinkDialogOpen(false);
      setFormulaLinkPicking(false);
      setFormulaLinkPickedCell(null);
    },
    [flushDraftToStore, createFormulaLink, scheduleEval, refreshDraftFromStore],
  );

  const handleDeleteFormulaLink = useCallback(
    (linkId: string) => {
      flushDraftToStore();
      deleteFormulaLink(draftRef.current.id, linkId);
      refreshDraftFromStore();
      toast.success("Связь с формулой удалена");
    },
    [flushDraftToStore, deleteFormulaLink, refreshDraftFromStore],
  );

  // ---- Formula create dialog (f+ button) handlers ----
  const handleOpenFormulaCreateDialog = useCallback(() => {
    setFormulaCreatePickedCell(null);
    setFormulaCreatePicking(false);
    setFormulaCreateDialogOpen(true);
  }, []);

  const handleCloseFormulaCreateDialog = useCallback(() => {
    setFormulaCreateDialogOpen(false);
    setFormulaCreatePicking(false);
    setFormulaCreatePickedCell(null);
  }, []);

  const handleFormulaCreatePickCell = useCallback((row: number, col: number) => {
    setFormulaCreatePickedCell({ row, col });
    setFormulaCreatePicking(false);
  }, []);

  const handleCreateFormula = useCallback(
    (opts: {
      name: string;
      formula?: string;
      comment?: string;
      matrixCells?: Array<{ row: number; col: number }>;
      type: FormulaCreateType;
    }) => {
      flushDraftToStore();
      const newId = createFormulaFromTable(draftRef.current.id, opts);
      if (newId) {
        scheduleEval();
        refreshDraftFromStore();
        toast.success(`Создана запись «${opts.name}» в калькуляторе`);
      } else {
        toast.error("Не удалось создать запись (проверьте имя)");
      }
      setFormulaCreateDialogOpen(false);
      setFormulaCreatePicking(false);
      setFormulaCreatePickedCell(null);
    },
    [flushDraftToStore, createFormulaFromTable, scheduleEval, refreshDraftFromStore],
  );

  // When the formulaStore changes (e.g. background recalc updated values),
  // push the new values to formula cells in the draft. This is debounced to
  // avoid thrashing. The scheduleEval loop already handles the main sync, but
  // this catches cases where the formulaStore changed externally (e.g. user
  // edited a constant in the calculator panel).
  //
  // IMPORTANT: We compare a VALUES SIGNATURE (id:value:formula for each entry)
  // rather than the formulaStore reference. recalculateFormulas always
  // returns new object references even when values are unchanged, so a naive
  // reference check would fire this effect on every recalc — causing a storm
  // of pushFormulaValuesToCells calls. The signature check ensures we only
  // push when actual values changed.
  useEffect(() => {
    if (!formulaStore) return;
    // Build a compact signature of all formula values + expressions.
    const sig = formulaStore.formulas
      .map((f) => `${f.id}:${f.value ?? ""}:${f.formula}`)
      .join("|");
    if (sig === lastFormulaSigRef.current) return;
    lastFormulaSigRef.current = sig;

    const t = setTimeout(() => {
      const newCells = pushFormulaValuesToCells(draftRef.current.id);
      if (newCells) {
        setDraft((prev) => {
          if (prev.cells === newCells) return prev;
          return { ...prev, cells: newCells };
        });
      }
    }, 200);
    return () => clearTimeout(t);
  }, [formulaStore, pushFormulaValuesToCells]);

  // ---- Render ----
  return (
    <>
      <DialogHeader className="px-4 py-3 border-b flex-shrink-0 flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Table2 className="h-5 w-5 text-primary flex-shrink-0" />
          <Input
            value={draft.name}
            onChange={(e) => handleNameChange(e.target.value)}
            className="h-8 max-w-xs"
            placeholder="Имя таблицы"
          />
          <span className="text-xs text-muted-foreground hidden md:inline">
            Выбор: <span className="font-mono">{selectionRange}</span>
            {" · "}
            Якорь: <span className="font-mono">{selectionRef}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleOpenCreateZone}
          >
            <Plus className="h-4 w-4" />
            Создать зону
          </Button>
          <div className="h-6 w-px bg-border mx-1" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Отменить (Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            title="Повторить (Ctrl+Y)"
          >
            <Redo2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setHistoryOpen(true)}
            title="История действий"
          >
            <History className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={handleClose} title="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </DialogHeader>

      <TableToolbar
        selection={selection}
        activeStyle={activeCellStyle}
        onApplyStyle={handleApplyStyle}
        onMerge={handleMerge}
        onUnmerge={handleUnmerge}
        onDeleteRow={handleDeleteRow}
        onDeleteCol={handleDeleteCol}
        onLinkFormula={handleOpenFormulaLinkDialog}
        onCreateFormula={handleOpenFormulaCreateDialog}
        onLinkAutoFill={handleOpenCellLinkDialog}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          {/* Formula preview bar — inside the left area, above the grid */}
          <FormulaPreviewBar
            key={selectionRef}
            cellValue={
              draft.cells[selection.startRow]?.[selection.startCol]?.raw ?? null
            }
            cellRef={selectionRef}
            onEdit={(value) => handleCellEdit(selection.startRow, selection.startCol, value)}
          />

          <TableGrid
            doc={draft}
            selection={selection}
            onSelectionChange={setSelection}
            onCellEdit={handleCellEdit}
            onInsertRow={handleInsertRow}
            onInsertCol={handleInsertCol}
            onDeleteRow={handleDeleteRow}
            onDeleteCol={handleDeleteCol}
            editingCell={editingCell}
            onEditingCellChange={handleEditingCellChange}
            editInitialChar={editInitialChar}
            onFillComplete={handleFillComplete}
            pickMode={cellPicking || formulaLinkPicking || formulaCreatePicking}
            onPickCell={(row, col) => {
              if (cellPicking) handlePickCell(row, col);
              else if (formulaLinkPicking) handleFormulaLinkPickCell(row, col);
              else if (formulaCreatePicking) handleFormulaCreatePickCell(row, col);
            }}
            containerRefCallback={(el) => {
              gridScrollRef.current = el;
            }}
          />
        </div>

        <RightPanel
          width={panelWidth}
          onWidthChange={setPanelWidth}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed((c) => !c)}
          doc={draft}
          tableId={draft.id}
          gridScrollRef={gridScrollRef}
          onDeleteCellLink={handleDeleteCellLink}
          onDeleteFormulaLink={handleDeleteFormulaLink}
        />
      </div>

      {/* Zones bar (collapsible list of named zones) */}
      <ZonesBar
        zones={draft.zones}
        onCreate={handleOpenCreateZone}
        onEdit={handleEditZone}
        onDelete={handleDeleteZone}
        onSelect={(z) =>
          setSelection({
            startRow: z.row,
            startCol: z.col,
            endRow: z.row + z.rowSpan - 1,
            endCol: z.col + z.colSpan - 1,
          })
        }
      />

      {/* Zone create/edit dialog */}
      <Dialog open={zoneDialogOpen} onOpenChange={setZoneDialogOpen}>
        <DialogContent className="sm:max-w-md" style={{ zIndex: 10001 }}>
          <DialogHeader>
            <DialogTitle>
              {editingZone ? "Редактировать зону" : "Создать зону"}
            </DialogTitle>
            <DialogDescription>
              Зона — это именованная область таблицы для доступа AI.
              Текущий выбор:{" "}
              <span className="font-mono">{selectionRange}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="zone-name">Имя зоны</Label>
              <Input
                id="zone-name"
                value={zoneForm.name}
                onChange={(e) =>
                  setZoneForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="Напр. «Итоги по продажам»"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="zone-desc">Описание</Label>
              <Input
                id="zone-desc"
                value={zoneForm.description}
                onChange={(e) =>
                  setZoneForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Что находится в этой области"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setZoneDialogOpen(false)}>
              Отмена
            </Button>
            <Button onClick={handleSaveZone}>
              <Save className="h-4 w-4" />
              Сохранить
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* History modal — list of undo entries (newest first). Clicking an
          entry restores the draft to that snapshot and pushes the
          in-between states onto the redo stack (so Ctrl+Y walks forward). */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-md" style={{ zIndex: 10001 }}>
          <DialogHeader>
            <DialogTitle>История действий</DialogTitle>
            <DialogDescription>
              Нажмите на запись, чтобы вернуться к этому состоянию.
              {" Ctrl+Z"} — отменить,{" Ctrl+Y"} — повторить.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-[60vh] pr-3">
            {undoStack.length === 0 && redoStack.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                История пуста
              </div>
            ) : (
              <ol className="flex flex-col gap-1">
                {/* Redo entries (future states) — shown oldest-first at the
                    top so the timeline reads top=oldest → bottom=newest. */}
                {redoStack.map((entry, i) => (
                  <li
                    key={`redo-${i}-${entry.ts}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                  >
                    <span className="truncate">{entry.description}</span>
                    <span className="font-mono text-xs flex-shrink-0">
                      {formatTime(entry.ts)}
                    </span>
                  </li>
                ))}
                {/* Current state — non-clickable marker. */}
                <li className="flex items-center justify-between gap-3 rounded-md border-2 border-primary bg-primary/10 px-3 py-2 text-sm font-medium">
                  <span className="truncate">Текущее состояние</span>
                  <span className="font-mono text-xs flex-shrink-0">сейчас</span>
                </li>
                {/* Undo entries (past states) — newest first (i.e. closest
                    to "current" at the top of this section). */}
                {undoStack
                  .map((entry, i) => ({ entry, i }))
                  .reverse()
                  .map(({ entry, i }) => (
                    <li key={`undo-${i}-${entry.ts}`}>
                      <button
                        type="button"
                        onClick={() => handleRestoreFromHistory(i)}
                        className="flex w-full items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                        title="Вернуться к этому состоянию"
                      >
                        <span className="truncate">{entry.description}</span>
                        <span className="font-mono text-xs text-muted-foreground flex-shrink-0">
                          {formatTime(entry.ts)}
                        </span>
                      </button>
                    </li>
                  ))}
              </ol>
            )}
          </ScrollArea>
          <div className="flex justify-between items-center pt-2">
            <span className="text-xs text-muted-foreground">
              Записей: {undoStack.length} (макс. 50)
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleUndo}
                disabled={undoStack.length === 0}
              >
                <Undo2 className="h-4 w-4" />
                Отменить
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRedo}
                disabled={redoStack.length === 0}
              >
                <Redo2 className="h-4 w-4" />
                Повторить
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Cell link (Link to AutoFill) dialog */}
      <CellLinkDialog
        open={cellLinkDialogOpen}
        picking={cellPicking}
        pickedCell={pickedCell}
        initialCoord={cellLinkInitialCoord}
        onPickingChange={setCellPicking}
        onCreate={handleCreateCellLink}
        onClose={handleCloseCellLinkDialog}
      />

      {/* Formula link (f button) dialog */}
      <FormulaLinkDialog
        open={formulaLinkDialogOpen}
        picking={formulaLinkPicking}
        pickedCell={formulaLinkPickedCell}
        initialCoord={formulaLinkInitialCoord}
        onPickingChange={setFormulaLinkPicking}
        formulas={formulaStore?.formulas ?? []}
        tableCells={draft.cells}
        onLinkConstant={handleLinkConstant}
        onLinkFunction={handleLinkFunction}
        onClose={handleCloseFormulaLinkDialog}
      />

      {/* Formula create (f+ button) dialog */}
      <FormulaCreateDialog
        open={formulaCreateDialogOpen}
        picking={formulaCreatePicking}
        pickedCell={formulaCreatePickedCell}
        selectionRange={selectionRangeObj}
        onPickingChange={setFormulaCreatePicking}
        onCreate={handleCreateFormula}
        onClose={handleCloseFormulaCreateDialog}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// ZonesBar — a thin bottom bar listing named zones with edit/delete buttons.
// ---------------------------------------------------------------------------

interface ZonesBarProps {
  zones: NamedZone[];
  onCreate: () => void;
  onEdit: (z: NamedZone) => void;
  onDelete: (id: string) => void;
  onSelect: (z: NamedZone) => void;
}

function ZonesBar({ zones, onCreate, onEdit, onDelete, onSelect }: ZonesBarProps) {
  if (zones.length === 0) {
    return null;
  }
  return (
    <div className="flex-shrink-0 border-t bg-muted/30 px-3 py-1.5">
      <div className="flex items-center gap-2 overflow-x-auto">
        <span className="text-xs font-medium text-muted-foreground flex-shrink-0">
          Зоны ({zones.length}):
        </span>
        {zones.map((z) => (
          <div
            key={z.id}
            className="flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs flex-shrink-0"
          >
            <button
              type="button"
              onClick={() => onSelect(z)}
              className="font-medium hover:underline"
              title={`Перейти к зоне «${z.name}» (${z.row},${z.col}) ${z.rowSpan}x${z.colSpan}`}
            >
              {z.name}
            </button>
            <button
              type="button"
              onClick={() => onEdit(z)}
              className="text-muted-foreground hover:text-foreground"
              title="Редактировать"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(z.id)}
              className="text-muted-foreground hover:text-destructive"
              title="Удалить"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onCreate}
        >
          <Plus className="h-3 w-3" />
          Добавить
        </Button>
      </div>
    </div>
  );
}
