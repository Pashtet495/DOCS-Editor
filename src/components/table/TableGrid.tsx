"use client";

/**
 * TableGrid — the editable spreadsheet grid.
 *
 * Responsibilities:
 *  - Render an HTML <table> with row headers (1,2,3…) and column headers (A,B,C…).
 *  - Display cells via `getDisplayValue(cell)` (formula-aware).
 *  - Selection: click = single cell, click+drag / shift+click = rectangle range.
 *  - Row/col header click selects the entire row/column.
 *  - Editing: double-click a cell, or start typing, to enter edit mode.
 *    Enter commits, Escape cancels, Tab commits+moves right, Shift+Tab left.
 *  - Merged cells render via colSpan/rowSpan; non-topleft cells of a merge are
 *    skipped from the DOM (return null) so the table layout stays correct.
 *  - Cell styles: font, bold, italic, color, fill, alignment, textRotation,
 *    borders. Default border color is a semi-transparent gray (#e0e0e0).
 *  - Keyboard navigation: arrows move selection (with shift = extend range).
 *  - Context menu (right-click) on row/col headers offers insert/delete.
 *
 * The grid is "dumb" w.r.t. persistence: it calls `onCellEdit`, `onSelectionChange`,
 * `onEditingCellChange`, `onInsertRow/Col`, `onDeleteRow/Col`. The parent owns
 * the draft state and re-evaluates formulas on edit (debounced 300ms).
 *
 * Performance: each cell is rendered by a `React.memo`-ized `GridCell` whose
 * props are primitives or stable references, so editing one cell only
 * re-renders that cell + the previously-edited one — not the whole grid.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getDisplayValue, extractCellRefs } from "@/lib/table/formula-engine";
import {
  findMergeAt,
  normalizeSelection,
  colToLetter,
  toCellRef,
} from "@/lib/table/cell-utils";
import type {
  TableDoc,
  Cell,
  CellStyle,
  Selection,
  Merge,
  BorderStyle,
} from "@/lib/table/types";
import { cn } from "@/lib/utils";
import { Plus, Link2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

const DEFAULT_BORDER_COLOR = "#e0e0e0";

/** Colors for highlighting formula cell references (cycled). */
const FORMULA_REF_COLORS = ["#dc2626", "#2563eb", "#16a34a", "#ca8a04", "#9333ea", "#0891b2"];

const BORDER_WIDTH: Record<BorderStyle["style"], string> = {
  thin: "1px",
  medium: "2px",
  thick: "3px",
  dashed: "1px",
  dotted: "1px",
  double: "3px",
};

const BORDER_STYLE_CSS: Record<BorderStyle["style"], string> = {
  thin: "solid",
  medium: "solid",
  thick: "solid",
  dashed: "dashed",
  dotted: "dotted",
  double: "double",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TableGridProps {
  doc: TableDoc;
  selection: Selection;
  onSelectionChange: (sel: Selection) => void;
  onCellEdit: (row: number, col: number, raw: string) => void;
  onInsertRow: (row: number, count: number) => void; // insert BEFORE this row
  onInsertCol: (col: number, count: number) => void; // insert BEFORE this col
  onDeleteRow: (row: number) => void;
  onDeleteCol: (col: number) => void;
  editingCell: { row: number; col: number } | null;
  onEditingCellChange: (cell: { row: number; col: number } | null) => void;
  /** When set, editing starts with this character pre-filled (direct typing). */
  editInitialChar?: string | null;
  /** Called when a cell is clicked during formula editing (value starts with "=").
   *  The parent should insert the cell reference into the editing input. */
  onInsertCellRef?: (row: number, col: number) => void;
  /** Called when the fill handle drag is completed. The parent should fill
   *  cells from the source selection into the target range.
   *  @param sourceSel The original selection (source of the fill)
   *  @param targetSel The extended range (source + filled cells) */
  onFillComplete?: (sourceSel: Selection, targetSel: Selection) => void;
  /** When true, clicking a cell calls `onPickCell` instead of selecting it.
   *  Used by the CellLinkDialog's cell-reference picker. */
  pickMode?: boolean;
  /** Called when a cell is clicked while `pickMode` is true. */
  onPickCell?: (row: number, col: number) => void;
  /** Optional callback that exposes the grid's scroll container element to
   *  the parent. Used by the RightPanel for sync-scroll. */
  containerRefCallback?: (el: HTMLDivElement | null) => void;
}

// ---------------------------------------------------------------------------
// Pre-computed grid model — one entry per (row, col), including merge info.
// ---------------------------------------------------------------------------

interface CellRenderInfo {
  cell: Cell | null;
  row: number;
  col: number;
  /** Merge that contains this cell (or null). */
  merge: Merge | null;
  /** True for non-topleft cells of a merge — they are skipped in the DOM. */
  hiddenByMerge: boolean;
  colSpan: number;
  rowSpan: number;
}

function buildCellMatrix(doc: TableDoc): CellRenderInfo[][] {
  const { cells, rowCount, colCount, merges } = doc;
  const matrix: CellRenderInfo[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: CellRenderInfo[] = [];
    for (let c = 0; c < colCount; c++) {
      const merge = findMergeAt(r, c, merges);
      let hiddenByMerge = false;
      let colSpan = 1;
      let rowSpan = 1;
      if (merge) {
        if (merge.row === r && merge.col === c) {
          colSpan = merge.colSpan;
          rowSpan = merge.rowSpan;
        } else {
          hiddenByMerge = true;
        }
      }
      const cellData = cells[r]?.[c] ?? null;
      row.push({
        cell: cellData,
        row: r,
        col: c,
        merge,
        hiddenByMerge,
        colSpan,
        rowSpan,
      });
    }
    matrix.push(row);
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function borderCss(s: BorderStyle | undefined): string | undefined {
  if (!s) return undefined;
  return `${BORDER_WIDTH[s.style]} ${BORDER_STYLE_CSS[s.style]} ${s.color}`;
}

function cellStyleToCss(style: CellStyle | undefined): React.CSSProperties {
  if (!style) return {};
  const css: React.CSSProperties = {};
  if (style.fontFamily) css.fontFamily = style.fontFamily;
  if (style.fontSize) css.fontSize = `${style.fontSize}pt`;
  if (style.bold) css.fontWeight = "bold";
  if (style.italic) css.fontStyle = "italic";
  if (style.underline) css.textDecoration = "underline";
  if (style.strikethrough) {
    css.textDecoration = (css.textDecoration ?? "") + " line-through";
  }
  if (style.fontColor) css.color = style.fontColor;
  if (style.fillColor) css.backgroundColor = style.fillColor;
  if (style.hAlign) css.textAlign = style.hAlign;
  if (style.vAlign) {
    css.verticalAlign =
      style.vAlign === "top" ? "top" : style.vAlign === "bottom" ? "bottom" : "middle";
  }
  if (style.textRotation) {
    // Excel: positive = counterclockwise. CSS rotate is clockwise-positive, so negate.
    css.transform = `rotate(${-style.textRotation}deg)`;
    css.transformOrigin = "center";
    css.whiteSpace = "nowrap";
  }
  const bt = borderCss(style.borderTop);
  const bb = borderCss(style.borderBottom);
  const bl = borderCss(style.borderLeft);
  const br = borderCss(style.borderRight);
  if (bt) css.borderTop = bt;
  if (bb) css.borderBottom = bb;
  if (bl) css.borderLeft = bl;
  if (br) css.borderRight = br;
  return css;
}

// ---------------------------------------------------------------------------
// Memoized cell renderer
// ---------------------------------------------------------------------------

interface GridCellProps {
  info: CellRenderInfo;
  displayValue: string;
  /** Cell style object — stable reference from doc, enables React.memo. */
  cellStyle?: CellStyle;
  isSelected: boolean;
  isEditing: boolean;
  isPrimarySelected: boolean;
  initialChar?: string | null;
  /** If true, editing started via double-click → select all text on mount. */
  selectOnEdit?: boolean;
  /** If this cell is referenced by the primary selected cell's formula, this
   *  is the highlight color (otherwise undefined). */
  formulaRefColor?: string;
  /** If true, show the fill handle (small square at bottom-right corner).
   *  Only shown on the bottom-right cell of the primary selection. */
  showFillHandle?: boolean;
  /** If true, the cell has a linkId (linked to auto-fill) — render a small
   *  link icon in the top-right corner as a visual indicator. */
  isLinked?: boolean;
  /** If true, the cell has a formulaLinkId (linked to a calculator formula) —
   *  render a brick-red link icon. Distinct from the AutoFill blue icon. */
  isFormulaLinked?: boolean;
  /** If true, the cell is a read-only formula function cell (cannot edit). */
  isFormulaReadOnly?: boolean;
  onCellMouseDown: (e: React.MouseEvent, row: number, col: number) => void;
  onCellMouseEnter: (row: number, col: number) => void;
  onCellDoubleClick: (row: number, col: number) => void;
  onEditCommit: (row: number, col: number, raw: string) => void;
  onEditCancel: () => void;
  onEditMove: (dr: number, dc: number) => void;
  onEditValueChange?: (value: string) => void;
  onEditInputRef?: (el: HTMLInputElement | null) => void;
  /** Called when the fill handle is grabbed (mousedown on the handle). */
  onFillStart?: (e: React.MouseEvent, row: number, col: number) => void;
}

const GridCell = React.memo(function GridCell(props: GridCellProps) {
  const {
    info,
    displayValue,
    cellStyle,
    isSelected,
    isEditing,
    isPrimarySelected,
    initialChar,
    selectOnEdit,
    formulaRefColor,
    showFillHandle,
    isLinked,
    isFormulaLinked,
    isFormulaReadOnly,
    onCellMouseDown,
    onCellMouseEnter,
    onCellDoubleClick,
    onEditCommit,
    onEditCancel,
    onEditMove,
    onEditValueChange,
    onEditInputRef,
    onFillStart,
  } = props;

  if (info.hiddenByMerge) {
    return null; // Skipped — topleft cell of the merge renders with colSpan/rowSpan.
  }

  // Compute CSS from cell style INSIDE the memoized component.
  // This way the CSS object is only recomputed when the cell actually changes,
  // not on every selection change.
  const css = cellStyleToCss(cellStyle);
  const defaultBorder = `1px solid ${DEFAULT_BORDER_COLOR}`;

  const mergedStyle: React.CSSProperties = {
    ...css,
    minWidth: "60px",
    minHeight: "24px",
    overflow: "hidden",
    whiteSpace: info.colSpan > 1 ? "normal" : "nowrap",
    textOverflow: "ellipsis",
    // Each border is independent: if explicitly set, use it; otherwise show
    // the default gray gridline. Never use the `borderColor` shorthand.
    borderTop: css.borderTop || defaultBorder,
    borderBottom: css.borderBottom || defaultBorder,
    borderLeft: css.borderLeft || defaultBorder,
    borderRight: css.borderRight || defaultBorder,
    // Formula reference highlight: colored outline (like Excel)
    ...(formulaRefColor
      ? {
          outline: `2px solid ${formulaRefColor}`,
          outlineOffset: "-2px",
          zIndex: 1,
          position: "relative" as const,
        }
      : isPrimarySelected
        ? {
            outline: "2px solid #2563eb",
            outlineOffset: "-2px",
            zIndex: 2,
            position: "relative" as const,
          }
        : isSelected
          ? {
              backgroundColor: (css.backgroundColor as string) ?? "rgba(37, 99, 235, 0.10)",
              outline: "1px solid rgba(37, 99, 235, 0.45)",
              outlineOffset: "-1px",
            }
          : {}),
  };

  return (
    <td
      rowSpan={info.rowSpan}
      colSpan={info.colSpan}
      className="relative px-1.5 py-1 text-sm select-none"
      style={mergedStyle}
      onMouseDown={(e) => onCellMouseDown(e, info.row, info.col)}
      onMouseEnter={() => onCellMouseEnter(info.row, info.col)}
      onDoubleClick={() => onCellDoubleClick(info.row, info.col)}
    >
      {isEditing ? (
        <CellEditInput
          initialValue={initialChar ?? info.cell?.raw ?? ""}
          css={css}
          onCommit={(raw) => onEditCommit(info.row, info.col, raw)}
          onCancel={onEditCancel}
          onMove={onEditMove}
          onValueChange={onEditValueChange}
          inputRefCallback={onEditInputRef}
          selectOnMount={selectOnEdit}
        />
      ) : (
        <span
          className="block truncate"
          style={{
            transform: css.transform,
            transformOrigin: css.transformOrigin,
            whiteSpace: css.whiteSpace as "nowrap" | "normal" | undefined,
            display: css.transform ? "inline-block" : "block",
          }}
          title={displayValue}
        >
          {displayValue}
        </span>
      )}
      {/* Link indicator — small icon in the top-right corner of cells
          that are linked to auto-fill. pointer-events:none so the cell
          itself stays clickable. */}
      {isLinked && !isEditing && (
        <span
          aria-label="Связано с автозаполнением"
          title="Связано с автозаполнением"
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 12,
            height: 12,
            color: "#1e40af",
            pointerEvents: "none",
            zIndex: 4,
            opacity: 0.85,
          }}
        >
          <Link2 className="h-3 w-3" />
        </span>
      )}
      {/* Formula link indicator — brick-red icon for cells linked to a
          calculator formula/constant. Positioned at top-LEFT to distinguish
          from AutoFill's top-right blue icon. */}
      {isFormulaLinked && !isEditing && (
        <span
          aria-label="Связано с формулой калькулятора"
          title="Связано с формулой калькулятора"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 12,
            height: 12,
            color: "#991b1b",
            pointerEvents: "none",
            zIndex: 4,
            opacity: 0.85,
          }}
        >
          <Link2 className="h-3 w-3" />
        </span>
      )}
      {/* Fill handle — small square at bottom-right corner of the primary selection.
          Dragging it fills/copies cells (Excel-like behavior). */}
      {showFillHandle && !isEditing && (
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            onFillStart?.(e, info.row, info.col);
          }}
          style={{
            position: "absolute",
            bottom: -5,
            right: -5,
            width: 10,
            height: 10,
            backgroundColor: "#2563eb",
            border: "1px solid #fff",
            cursor: "crosshair",
            zIndex: 5,
          }}
        />
      )}
    </td>
  );
});

// ---------------------------------------------------------------------------
// CellEditInput — mounted fresh each time editing starts (conditionally
// rendered by GridCell), so its useState initializes from `initialValue`
// without needing a setState-in-effect.
// ---------------------------------------------------------------------------

interface CellEditInputProps {
  initialValue: string;
  css: React.CSSProperties;
  onCommit: (raw: string) => void;
  onCancel: () => void;
  onMove: (dr: number, dc: number) => void;
  /** Called on every value change — parent uses this to detect formula mode. */
  onValueChange?: (value: string) => void;
  /** Exposes the input element to the parent so it can insert cell refs. */
  inputRefCallback?: (el: HTMLInputElement | null) => void;
  /** If true (double-click edit), select all text on mount. If false (direct
   *  typing), place cursor at end so the first char isn't selected. */
  selectOnMount?: boolean;
}

function CellEditInput(props: CellEditInputProps) {
  const { initialValue, css, onCommit, onCancel, onMove, onValueChange, inputRefCallback, selectOnMount = false } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<string>(initialValue);
  const committedRef = useRef(false);

  // Focus on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (selectOnMount) {
        // Double-click edit: select all text (user wants to replace)
        input.select();
      } else {
        // Direct typing: place cursor at end (don't select — first char
        // was already pre-filled via editInitialChar)
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [selectOnMount]);

  // Expose the input element to the parent.
  useEffect(() => {
    inputRefCallback?.(inputRef.current);
    return () => inputRefCallback?.(null);
  }, [inputRefCallback]);

  // Notify parent of value changes.
  useEffect(() => {
    onValueChange?.(value);
  }, [value, onValueChange]);

  const commit = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  }, [value, onCommit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
      onMove(1, 0);
    } else if (e.key === "Tab") {
      e.preventDefault();
      commit();
      onMove(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      committedRef.current = true; // suppress blur commit
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={commit}
      className="w-full h-full bg-white text-black outline-none px-0.5 border-2 border-blue-500 rounded-sm"
      style={{
        fontFamily: css.fontFamily as string | undefined,
        fontSize: css.fontSize as string | number | undefined,
        fontWeight: css.fontWeight as React.CSSProperties["fontWeight"],
        fontStyle: css.fontStyle as React.CSSProperties["fontStyle"],
        color: css.color as string | undefined,
        minWidth: "100%",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

// ---------------------------------------------------------------------------
// Insert helpers — hover-activated "+" buttons between row/col headers.
//
// The user hovers a thin (6px) transparent strip centered on the boundary
// between two adjacent headers; a small circular "+" button fades in centered
// on that boundary. Left-click inserts 1; right-click opens a context menu
// with options for 1, 2, 3, 5, 10.
//
// The button is a child of the header <th> and is positioned absolutely so it
// overflows past the th's edge into the neighbour's territory. To make sure
// the overflowing button paints above the neighbour, the parent header bumps
// its own z-index (via `onHoverChange`) while the zone is hovered.
// ---------------------------------------------------------------------------

const INSERT_COUNTS = [1, 2, 3, 5, 10] as const;

const ROW_INSERT_LABELS: Record<number, string> = {
  1: "Вставить 1 строку",
  2: "Вставить 2 строки",
  3: "Вставить 3 строки",
  5: "Вставить 5 строк",
  10: "Вставить 10 строк",
};

const COL_INSERT_LABELS: Record<number, string> = {
  1: "Вставить 1 столбец",
  2: "Вставить 2 столбца",
  3: "Вставить 3 столбца",
  5: "Вставить 5 столбцов",
  10: "Вставить 10 столбцов",
};

/**
 * InsertButton — the small circular "+" that appears on a header boundary.
 * - Left-click inserts 1 row/col at the boundary (default action).
 * - Right-click opens a context menu with options for 1, 2, 3, 5, 10.
 * - Semi-transparent at rest, fully visible on hover.
 *
 * `onContextMenu` stops propagation so the surrounding header's own
 * ContextMenu doesn't also open.
 */
function InsertButton({
  orientation,
  onInsert,
}: {
  orientation: "row" | "col";
  onInsert: (count: number) => void;
}) {
  const labels = orientation === "row" ? ROW_INSERT_LABELS : COL_INSERT_LABELS;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          aria-label={orientation === "row" ? "Вставить строку" : "Вставить столбец"}
          title={orientation === "row" ? "Вставить строку" : "Вставить столбец"}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-white shadow-md opacity-60 transition hover:scale-110 hover:bg-blue-600 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onInsert(1);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          <Plus className="h-3 w-3" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {INSERT_COUNTS.map((n) => (
          <ContextMenuItem key={n} onClick={() => onInsert(n)}>
            {labels[n]}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * InsertZone — a thin transparent hover strip placed at the bottom edge of a
 * row header (orientation="row") or the right edge of a col header
 * (orientation="col"). On hover, the InsertButton fades in centered on the
 * boundary (which is the strip's center).
 *
 * `onHoverChange` lets the parent header bump its z-index so the (overflowing)
 * button paints above the adjacent header.
 */
function InsertZone({
  orientation,
  onInsert,
  onHoverChange,
}: {
  orientation: "row" | "col";
  onInsert: (count: number) => void;
  onHoverChange: (hovered: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);

  const handleEnter = useCallback(() => {
    setHovered(true);
    onHoverChange(true);
  }, [onHoverChange]);

  const handleLeave = useCallback(() => {
    setHovered(false);
    onHoverChange(false);
  }, [onHoverChange]);

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={
        orientation === "row"
          ? {
              position: "absolute",
              left: 0,
              right: 0,
              bottom: -3,
              height: 6,
              zIndex: 40,
              cursor: "pointer",
            }
          : {
              position: "absolute",
              top: 0,
              bottom: 0,
              right: -3,
              width: 6,
              zIndex: 40,
              cursor: "pointer",
            }
      }
    >
      {hovered && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 50,
          }}
        >
          <InsertButton orientation={orientation} onInsert={onInsert} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row / Column header cells with context menu
// ---------------------------------------------------------------------------

interface RowHeaderProps {
  row: number;
  height: number;
  isSelected: boolean;
  onRowClick: (row: number, e: React.MouseEvent) => void;
  onRowMouseEnter: (row: number) => void;
  onInsertRow: (row: number, count: number) => void;
  onDeleteRow: (row: number) => void;
}

const RowHeader = React.memo(function RowHeader(props: RowHeaderProps) {
  const { row, height, isSelected, onRowClick, onRowMouseEnter, onInsertRow, onDeleteRow } = props;
  const [zoneHovered, setZoneHovered] = useState(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <th
          className={cn(
            "sticky left-0 bg-muted border-r border-b text-xs font-medium text-muted-foreground select-none cursor-pointer hover:bg-accent",
            isSelected && "bg-primary/15 text-primary",
          )}
          style={{ width: 40, height, position: "sticky", zIndex: zoneHovered ? 30 : 10 }}
          onClick={(e) => onRowClick(row, e)}
          onMouseEnter={() => onRowMouseEnter(row)}
        >
          {row + 1}
          <InsertZone
            orientation="row"
            onInsert={(count) => onInsertRow(row + 1, count)}
            onHoverChange={setZoneHovered}
          />
        </th>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onInsertRow(row, 1)}>
          Вставить строку выше
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onInsertRow(row + 1, 1)}>
          Вставить строку ниже
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onDeleteRow(row)} className="text-destructive">
          Удалить строку
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

interface ColHeaderProps {
  col: number;
  isSelected: boolean;
  onColClick: (col: number, e: React.MouseEvent) => void;
  onColMouseEnter: (col: number) => void;
  onInsertCol: (col: number, count: number) => void;
  onDeleteCol: (col: number) => void;
}

const ColHeader = React.memo(function ColHeader(props: ColHeaderProps) {
  const { col, isSelected, onColClick, onColMouseEnter, onInsertCol, onDeleteCol } = props;
  const [zoneHovered, setZoneHovered] = useState(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <th
          className={cn(
            "sticky top-0 bg-muted border-r border-b text-xs font-medium text-muted-foreground select-none cursor-pointer hover:bg-accent",
            isSelected && "bg-primary/15 text-primary",
          )}
          style={{ height: 24, minWidth: 40, position: "sticky", zIndex: zoneHovered ? 30 : 10 }}
          onClick={(e) => onColClick(col, e)}
          onMouseEnter={() => onColMouseEnter(col)}
        >
          {colToLetter(col)}
          <InsertZone
            orientation="col"
            onInsert={(count) => onInsertCol(col + 1, count)}
            onHoverChange={setZoneHovered}
          />
        </th>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onInsertCol(col, 1)}>
          Вставить столбец левее
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onInsertCol(col + 1, 1)}>
          Вставить столбец правее
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onDeleteCol(col)} className="text-destructive">
          Удалить столбец
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

// ---------------------------------------------------------------------------
// Main grid component
// ---------------------------------------------------------------------------

export function TableGrid(props: TableGridProps) {
  const {
    doc,
    selection,
    onSelectionChange,
    onCellEdit,
    onInsertRow,
    onInsertCol,
    onDeleteRow,
    onDeleteCol,
    editingCell,
    onEditingCellChange,
    editInitialChar,
    onInsertCellRef,
    onFillComplete,
    pickMode,
    onPickCell,
    containerRefCallback,
  } = props;

  const { rowCount, colCount } = doc;
  const matrix = useMemo(() => buildCellMatrix(doc), [doc]);

  // Stable callback for edit input ref — avoids creating a new function
  // on every render (which would break React.memo for all 1950 cells).
  const handleEditInputRef = useCallback((el: HTMLInputElement | null) => {
    editInputRef.current = el;
  }, []);

  // Drag state — kept in refs (no re-render needed while dragging).
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ row: number; col: number } | null>(null);
  /** Mouse position at mousedown — used to detect if the user actually dragged
   *  (moved > threshold) vs just clicked. Prevents false drag when the layout
   *  shifts (e.g. preview bar collapses) and the mouse ends up over a different cell. */
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  /** True once the mouse has moved beyond the drag threshold. */
  const dragActivatedRef = useRef(false);
  const [dragSelection, setDragSelection] = useState<Selection | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Formula editing state: when editing and value starts with "=", clicking
  // another cell inserts its reference instead of changing selection.
  const [editValue, setEditValue] = useState<string>("");
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const isFormulaEditing = editingCell !== null && editValue.startsWith("=");
  /** Whether the current edit session started via double-click (select all)
   *  vs direct typing (cursor at end). */
  const [editSelectOnMount, setEditSelectOnMount] = useState(false);

  // Fill handle state: when the user drags the fill handle (bottom-right
  // corner of the selection), we track the fill range.
  const [fillDragRange, setFillDragRange] = useState<Selection | null>(null);
  const isFillingRef = useRef(false);
  const fillStartRef = useRef<{ row: number; col: number } | null>(null);

  // Formula reference highlighting: when the primary selected cell contains a
  // formula, extract its cell references and highlight them with colored borders.
  // Each reference gets a distinct color (cycling through FORMULA_REF_COLORS).
  const formulaRefs = useMemo(() => {
    if (isFormulaEditing) return []; // don't highlight while editing
    const cell = doc.cells[selection.startRow]?.[selection.startCol];
    if (!cell || !cell.raw || !cell.raw.startsWith("=")) return [];
    const refs = extractCellRefs(cell.raw);
    return refs.map((ref, i) => ({
      ...ref,
      color: FORMULA_REF_COLORS[i % FORMULA_REF_COLORS.length],
    }));
  }, [doc, selection.startRow, selection.startCol, isFormulaEditing]);

  // Pre-compute formula reference color map for O(1) lookup instead of
  // calling .find() 1950 times per render.
  const formulaRefColorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of formulaRefs) {
      m.set(`${r.row}-${r.col}`, r.color);
    }
    return m;
  }, [formulaRefs]);

  const normSel = useMemo(() => normalizeSelection(selection), [selection]);
  const activeSel = dragSelection ?? normSel;

  // -------------------------------------------------------------------------
  // Selection helpers
  // -------------------------------------------------------------------------

  const setSelection = useCallback(
    (sel: Selection) => {
      onSelectionChange(sel);
    },
    [onSelectionChange],
  );

  const handleCellMouseDown = useCallback(
    (e: React.MouseEvent, row: number, col: number) => {
      // Pick mode: clicking a cell sets the coordinate in the parent dialog
      // (e.g. CellLinkDialog's cell-reference picker). No selection change.
      if (pickMode) {
        e.preventDefault();
        e.stopPropagation();
        onPickCell?.(row, col);
        return;
      }
      // Formula mode: clicking another cell inserts its reference.
      if (isFormulaEditing) {
        if (editingCell && editingCell.row === row && editingCell.col === col) return;
        e.preventDefault();
        const ref = toCellRef(row, col);
        const input = editInputRef.current;
        if (input) {
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? input.value.length;
          const newValue = input.value.slice(0, start) + ref + input.value.slice(end);
          // Update the input value + React state via native setter
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set;
          nativeSetter?.call(input, newValue);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          // Move cursor after the inserted ref
          const newPos = start + ref.length;
          input.setSelectionRange(newPos, newPos);
          input.focus();
        }
        // Also notify parent if callback provided
        onInsertCellRef?.(row, col);
        return;
      }
      // Skip if clicking inside an input (editing mode).
      if (editingCell && editingCell.row === row && editingCell.col === col) return;

      if (e.shiftKey && dragStartRef.current) {
        setSelection({
          startRow: dragStartRef.current.row,
          startCol: dragStartRef.current.col,
          endRow: row,
          endCol: col,
        });
        return;
      }

      isDraggingRef.current = true;
      dragActivatedRef.current = false; // not yet — needs mouse move beyond threshold
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
      dragStartRef.current = { row, col };
      setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
      setDragSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
    },
    [editingCell, isFormulaEditing, onInsertCellRef, setSelection, pickMode, onPickCell],
  );

  // End drag on mouseup anywhere. Activate drag on mousemove beyond threshold.
  useEffect(() => {
    const DRAG_THRESHOLD = 5; // pixels
    const onMouseUp = () => {
      isDraggingRef.current = false;
      dragActivatedRef.current = false;
      mouseDownPosRef.current = null;
      setDragSelection(null);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || dragActivatedRef.current) return;
      if (!mouseDownPosRef.current) return;
      const dx = Math.abs(e.clientX - mouseDownPosRef.current.x);
      const dy = Math.abs(e.clientY - mouseDownPosRef.current.y);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        dragActivatedRef.current = true;
      }
    };
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousemove", onMouseMove);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  const handleCellDoubleClick = useCallback(
    (row: number, col: number) => {
      // Don't enter edit mode for read-only formula function cells.
      const cell = doc.cells[row]?.[col];
      if (cell?.formulaLinkId && typeof cell.raw === "string" && cell.raw.startsWith("=")) {
        return;
      }
      setEditSelectOnMount(true);
      onEditingCellChange({ row, col });
    },
    [onEditingCellChange, doc.cells],
  );

  // -------------------------------------------------------------------------
  // Edit handlers
  // -------------------------------------------------------------------------

  const handleEditCommit = useCallback(
    (row: number, col: number, raw: string) => {
      onCellEdit(row, col, raw);
      onEditingCellChange(null);
      // Restore focus to the grid container so keyboard navigation works.
      requestAnimationFrame(() => containerRef.current?.focus());
    },
    [onCellEdit, onEditingCellChange],
  );

  const handleEditCancel = useCallback(() => {
    onEditingCellChange(null);
    requestAnimationFrame(() => containerRef.current?.focus());
  }, [onEditingCellChange]);

  const handleEditMove = useCallback(
    (dr: number, dc: number) => {
      const r = Math.max(0, Math.min(rowCount - 1, selection.startRow + dr));
      const c = Math.max(0, Math.min(colCount - 1, selection.startCol + dc));
      setSelection({ startRow: r, startCol: c, endRow: r, endCol: c });
    },
    [rowCount, colCount, selection.startRow, selection.startCol, setSelection],
  );

  // -------------------------------------------------------------------------
  // Fill handle (Excel-like drag-to-fill)
  // -------------------------------------------------------------------------

  const handleFillStart = useCallback(
    (e: React.MouseEvent, row: number, col: number) => {
      e.preventDefault();
      isFillingRef.current = true;
      fillStartRef.current = { row, col };
      const norm = normalizeSelection(selection);
      setFillDragRange({ ...norm });
    },
    [selection],
  );

  const handleFillMouseEnter = useCallback(
    (row: number, col: number) => {
      if (!isFillingRef.current || !fillStartRef.current) return;
      const norm = normalizeSelection(selection);
      const startRow = norm.startRow;
      const startCol = norm.startCol;
      const endRow = norm.endRow;
      const endCol = norm.endCol;

      // Support diagonal fill: extend BOTH row and col simultaneously.
      // The fill range grows to include the current cell in both directions.
      const newEndRow = Math.max(startRow, row);
      const newEndCol = Math.max(startCol, col);
      setFillDragRange({ startRow, startCol, endRow: newEndRow, endCol: newEndCol });
    },
    [selection],
  );

  // End fill on mouseup: call onFillComplete with source and target ranges.
  useEffect(() => {
    const onMouseUp = () => {
      if (!isFillingRef.current) return;
      isFillingRef.current = false;
      const norm = normalizeSelection(selection);
      if (fillDragRange && onFillComplete) {
        const target = normalizeSelection(fillDragRange);
        if (target.endRow > norm.endRow || target.endCol > norm.endCol ||
            target.startRow < norm.startRow || target.startCol < norm.startCol) {
          onFillComplete(norm, target);
        }
      }
      fillStartRef.current = null;
      setFillDragRange(null);
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [selection, fillDragRange, onFillComplete]);

  // Cell mouse enter — handles both fill drag and selection drag.
  const handleCellMouseEnter = useCallback(
    (row: number, col: number) => {
      // Fill drag takes priority over selection drag
      if (isFillingRef.current) {
        handleFillMouseEnter(row, col);
        return;
      }
      if (!isDraggingRef.current || !dragStartRef.current) return;
      if (!dragActivatedRef.current) return;
      const start = dragStartRef.current;
      const newSel = {
        startRow: start.row,
        startCol: start.col,
        endRow: row,
        endCol: col,
      };
      setDragSelection(newSel);
      setSelection(newSel);
    },
    [setSelection, handleFillMouseEnter],
  );

  // -------------------------------------------------------------------------
  // Row / column header clicks
  // -------------------------------------------------------------------------

  const handleRowHeaderClick = useCallback(
    (row: number, e: React.MouseEvent) => {
      if (e.shiftKey && dragStartRef.current) {
        setSelection({
          startRow: dragStartRef.current.row,
          startCol: 0,
          endRow: row,
          endCol: colCount - 1,
        });
        return;
      }
      dragStartRef.current = { row, col: 0 };
      isDraggingRef.current = true;
      dragActivatedRef.current = false;
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
      setSelection({
        startRow: row,
        startCol: 0,
        endRow: row,
        endCol: colCount - 1,
      });
      setDragSelection({
        startRow: row,
        startCol: 0,
        endRow: row,
        endCol: colCount - 1,
      });
    },
    [colCount, setSelection],
  );

  const handleColHeaderClick = useCallback(
    (col: number, e: React.MouseEvent) => {
      if (e.shiftKey && dragStartRef.current) {
        setSelection({
          startRow: 0,
          startCol: dragStartRef.current.col,
          endRow: rowCount - 1,
          endCol: col,
        });
        return;
      }
      dragStartRef.current = { row: 0, col };
      isDraggingRef.current = true;
      dragActivatedRef.current = false;
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
      setSelection({
        startRow: 0,
        startCol: col,
        endRow: rowCount - 1,
        endCol: col,
      });
      setDragSelection({
        startRow: 0,
        startCol: col,
        endRow: rowCount - 1,
        endCol: col,
      });
    },
    [rowCount, setSelection],
  );

  const handleRowHeaderMouseEnter = useCallback(
    (row: number) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      if (!dragActivatedRef.current) return;
      const start = dragStartRef.current;
      setSelection({
        startRow: start.row,
        startCol: 0,
        endRow: row,
        endCol: colCount - 1,
      });
      setDragSelection({
        startRow: start.row,
        startCol: 0,
        endRow: row,
        endCol: colCount - 1,
      });
    },
    [colCount, setSelection],
  );

  const handleColHeaderMouseEnter = useCallback(
    (col: number) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      if (!dragActivatedRef.current) return;
      const start = dragStartRef.current;
      setSelection({
        startRow: 0,
        startCol: start.col,
        endRow: rowCount - 1,
        endCol: col,
      });
      setDragSelection({
        startRow: 0,
        startCol: start.col,
        endRow: rowCount - 1,
        endCol: col,
      });
    },
    [rowCount, setSelection],
  );

  // -------------------------------------------------------------------------
  // Keyboard navigation
  // -------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editingCell) return;
      // Don't intercept clipboard hotkeys — parent handles Ctrl+C/X/V.
      // Use e.code (physical key) for layout-independent clipboard detection.
      if (e.ctrlKey || e.metaKey) {
        if (e.code === "KeyC" || e.code === "KeyX" || e.code === "KeyV" || e.code === "KeyA") return;
      }

      const r = selection.startRow;
      const c = selection.startCol;
      let nr = r;
      let nc = c;
      let extend = e.shiftKey;

      switch (e.key) {
        case "ArrowUp":
          nr = Math.max(0, r - 1);
          break;
        case "ArrowDown":
          nr = Math.min(rowCount - 1, r + 1);
          break;
        case "ArrowLeft":
          nc = Math.max(0, c - 1);
          break;
        case "ArrowRight":
          nc = Math.min(colCount - 1, c + 1);
          break;
        case "Tab":
          e.preventDefault();
          nc = e.shiftKey ? Math.max(0, c - 1) : Math.min(colCount - 1, c + 1);
          extend = false;
          break;
        case "Enter":
          e.preventDefault();
          nr = e.shiftKey ? Math.max(0, r - 1) : Math.min(rowCount - 1, r + 1);
          extend = false;
          break;
        case "Home":
          nc = 0;
          break;
        case "End":
          nc = colCount - 1;
          break;
        case "PageUp":
          nr = Math.max(0, r - 10);
          break;
        case "PageDown":
          nr = Math.min(rowCount - 1, r + 10);
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          for (let rr = normSel.startRow; rr <= normSel.endRow; rr++) {
            for (let cc = normSel.startCol; cc <= normSel.endCol; cc++) {
              // Skip read-only formula function cells.
              const cell = doc.cells[rr]?.[cc];
              if (cell?.formulaLinkId && typeof cell.raw === "string" && cell.raw.startsWith("=")) continue;
              onCellEdit(rr, cc, "");
            }
          }
          return;
        case "F2":
          e.preventDefault();
          {
            // Don't enter edit mode for read-only formula function cells.
            const cell = doc.cells[r]?.[c];
            if (cell?.formulaLinkId && typeof cell.raw === "string" && cell.raw.startsWith("=")) return;
          }
          setEditSelectOnMount(true); // F2 = edit mode, select all
          onEditingCellChange({ row: r, col: c });
          return;
        default:
          // Printable character → start editing with that character pre-filled.
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            // Don't enter edit mode for read-only formula function cells.
            const cell = doc.cells[r]?.[c];
            if (cell?.formulaLinkId && typeof cell.raw === "string" && cell.raw.startsWith("=")) return;
            setEditSelectOnMount(false); // Direct typing: cursor at end, don't select
            onEditingCellChange({ row: r, col: c });
            // The char will be picked up by the parent via editInitialChar
            return;
          }
          return;
      }

      e.preventDefault();
      if (extend) {
        setSelection({ ...selection, endRow: nr, endCol: nc });
      } else {
        setSelection({ startRow: nr, startCol: nc, endRow: nr, endCol: nc });
      }
    },
    [
      editingCell,
      selection,
      rowCount,
      colCount,
      normSel.startRow,
      normSel.startCol,
      normSel.endRow,
      normSel.endCol,
      setSelection,
      onEditingCellChange,
      onCellEdit,
      doc.cells,
    ],
  );

  // -------------------------------------------------------------------------
  // Selection helpers for individual cells
  // -------------------------------------------------------------------------

  const isCellSelected = useCallback(
    (r: number, c: number) =>
      r >= activeSel.startRow &&
      r <= activeSel.endRow &&
      c >= activeSel.startCol &&
      c <= activeSel.endCol,
    [activeSel],
  );

  const isPrimarySelected = useCallback(
    (r: number, c: number) =>
      r === selection.startRow && c === selection.startCol,
    [selection.startRow, selection.startCol],
  );

  // -------------------------------------------------------------------------
  // Column widths / row heights
  // -------------------------------------------------------------------------

  const colWidthMap = useMemo(() => {
    const m = new Map<number, number>();
    for (const cw of doc.colWidths) m.set(cw.col, cw.width);
    return m;
  }, [doc.colWidths]);

  const rowHeightMap = useMemo(() => {
    const m = new Map<number, number>();
    for (const rh of doc.rowHeights) m.set(rh.row, rh.height);
    return m;
  }, [doc.rowHeights]);

  // -------------------------------------------------------------------------
  // Row virtualization — only render visible rows for performance.
  // With 50 rows × 39 cols = 1950 cells, rendering all of them on every
  // selection change causes ~260ms delay. Virtualization reduces this to
  // ~20ms by only rendering the ~25 visible rows.
  // -------------------------------------------------------------------------
  const [visibleRowRange, setVisibleRowRange] = useState({ start: 0, end: 25 });
  const scrollUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleScroll = useCallback(() => {
    if (scrollUpdateTimerRef.current) clearTimeout(scrollUpdateTimerRef.current);
    scrollUpdateTimerRef.current = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      const scrollTop = container.scrollTop;
      const clientHeight = container.clientHeight;
      const defaultRowH = 26;
      const start = Math.max(0, Math.floor(scrollTop / defaultRowH) - 3);
      const end = Math.min(rowCount, Math.ceil((scrollTop + clientHeight) / defaultRowH) + 3);
      setVisibleRowRange((prev) => {
        if (prev.start === start && prev.end === end) return prev;
        return { start, end };
      });
    }, 16); // ~1 frame, fast enough for smooth scrolling
  }, [rowCount]);

  // On mount and when rowCount changes, recalculate visible range
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const clientHeight = container.clientHeight;
    const defaultRowH = 26;
    const end = Math.min(rowCount, Math.ceil(clientHeight / defaultRowH) + 3);
    setVisibleRowRange({ start: 0, end });
  }, [rowCount]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      ref={(el) => {
        containerRef.current = el;
        containerRefCallback?.(el);
      }}
      className={cn(
        "flex h-full w-full overflow-auto bg-white text-foreground font-sans outline-none",
        pickMode && "cursor-crosshair",
      )}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
    >
      <table className="border-collapse table-fixed" style={{ borderSpacing: 0 }}>
        <colgroup>
          <col style={{ width: 40 }} />
          {Array.from({ length: colCount }, (_, c) => (
            <col key={c} style={{ width: colWidthMap.get(c) ?? 90 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th
              className="sticky top-0 left-0 z-20 bg-muted border-r border-b"
              style={{ width: 40, height: 24 }}
            />
            {Array.from({ length: colCount }, (_, c) => {
              const isSel = c >= activeSel.startCol && c <= activeSel.endCol;
              return (
                <ColHeader
                  key={`col-h-${c}`}
                  col={c}
                  isSelected={isSel}
                  onColClick={handleColHeaderClick}
                  onColMouseEnter={handleColHeaderMouseEnter}
                  onInsertCol={onInsertCol}
                  onDeleteCol={onDeleteCol}
                />
              );
            })}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, r) => {
            const rowH = rowHeightMap.get(r) ?? 26;
            const isRowSel = r >= activeSel.startRow && r <= activeSel.endRow;
            // Virtualization: skip rendering cell content for non-visible rows.
            // The <tr> still exists (maintaining scroll height) but has no cells.
            const isVisible = r >= visibleRowRange.start && r < visibleRowRange.end;
            if (!isVisible) {
              return <tr key={`row-${r}`} style={{ height: rowH }} />;
            }
            return (
              <tr key={`row-${r}`} style={{ height: rowH }}>
                <RowHeader
                  row={r}
                  height={rowH}
                  isSelected={isRowSel}
                  onRowClick={handleRowHeaderClick}
                  onRowMouseEnter={handleRowHeaderMouseEnter}
                  onInsertRow={onInsertRow}
                  onDeleteRow={onDeleteRow}
                />
                {row.map((info) => {
                  if (info.hiddenByMerge) return null;
                  const cell = info.cell;
                  const displayValue = cell ? getDisplayValue(cell) : "";
                  return (
                    <GridCell
                      key={`cell-${info.row}-${info.col}`}
                      info={info}
                      displayValue={displayValue}
                      cellStyle={cell?.style}
                      isSelected={isCellSelected(info.row, info.col)}
                      isEditing={
                        !!editingCell &&
                        editingCell.row === info.row &&
                        editingCell.col === info.col
                      }
                      isPrimarySelected={isPrimarySelected(info.row, info.col)}
                      initialChar={
                        editingCell?.row === info.row && editingCell?.col === info.col
                          ? editInitialChar
                          : null
                      }
                      selectOnEdit={
                        editingCell?.row === info.row && editingCell?.col === info.col
                          ? editSelectOnMount
                          : false
                      }
                      formulaRefColor={formulaRefColorMap.get(`${info.row}-${info.col}`)}
                      showFillHandle={
                        !editingCell &&
                        info.row === normSel.endRow &&
                        info.col === normSel.endCol
                      }
                      isLinked={!!cell?.linkId}
                      isFormulaLinked={!!cell?.formulaLinkId}
                      isFormulaReadOnly={
                        !!cell?.formulaLinkId &&
                        typeof cell.raw === "string" &&
                        cell.raw.startsWith("=")
                      }
                      onCellMouseDown={handleCellMouseDown}
                      onCellMouseEnter={handleCellMouseEnter}
                      onCellDoubleClick={handleCellDoubleClick}
                      onEditCommit={handleEditCommit}
                      onEditCancel={handleEditCancel}
                      onEditMove={handleEditMove}
                      onEditValueChange={setEditValue}
                      onEditInputRef={handleEditInputRef}
                      onFillStart={handleFillStart}
                    />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
