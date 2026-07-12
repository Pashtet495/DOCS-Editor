// ============================================================================
// Table Types — data model for an Excel-like spreadsheet/table editor.
//
// Pure data types only. No React, no DOM. Stored as XML resources inside
// .docs archives alongside the main document so that AI agents can read and
// update tabular data without touching the prose flow.
// ============================================================================

/** A single cell in the spreadsheet */
export interface Cell {
  /** Raw value: a number, string, or formula (starts with "=") */
  raw: string;
  /** Computed value after formula evaluation (null if formula error or empty) */
  computed: string | number | null;
  /** Error message if formula evaluation failed */
  error?: string;
  /** Cell style properties */
  style?: CellStyle;
  /** Stable ID for cells linked to auto-fill rules. Survives row/col insert/delete
   *  because it's stored on the Cell object itself, not on coordinates. */
  linkId?: string;
  /** When set, this cell is part of a FORMULA link (calculator integration).
   *  Stores the CellLink.id (not the FormulaEntry.id). The cell's value is
   *  synced bidirectionally with the linked FormulaEntry:
   *    - constant link: cell ↔ FormulaEntry.value (editable cell).
   *    - function link: FormulaEntry.value → cell.computed (read-only cell).
   *    - matrix link:   cell range ↔ FormulaEntry.formula (editable cells).
   *  Distinct from `linkId` (which is for AutoFill links) so the two systems
   *  don't interfere. A cell can have BOTH linkId (AF) and formulaLinkId
   *  (calculator), though this is unusual. */
  formulaLinkId?: string;
}

export interface CellStyle {
  fontFamily?: string;
  fontSize?: number; // in pt
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontColor?: string; // hex like "#ff0000"
  fillColor?: string; // hex like "#ffff00"
  hAlign?: "left" | "center" | "right";
  vAlign?: "top" | "middle" | "bottom";
  /** Text rotation in degrees (-90 to 90). 0 = horizontal. */
  textRotation?: number;
  /** Border styles for each side. If undefined, cell uses default gray gridline. */
  borderTop?: BorderStyle;
  borderBottom?: BorderStyle;
  borderLeft?: BorderStyle;
  borderRight?: BorderStyle;
  /** Number format pattern (e.g. "#,##0.00" for numbers) */
  numberFormat?: string;
}

export type BorderStyle = {
  style: "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  color: string; // hex
};

/** A merged cell region */
export interface Merge {
  /** Top-left cell of the merge (row, col, 0-indexed) */
  row: number;
  col: number;
  /** Number of rows spanned */
  rowSpan: number;
  /** Number of columns spanned */
  colSpan: number;
}

/** A named zone — a user-defined region with a name and description for AI access */
export interface NamedZone {
  id: string;
  name: string;
  description: string;
  /** Top-left row (0-indexed) */
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/** Column width in pixels (default 80) */
export interface ColWidth {
  col: number;
  width: number;
}
/** Row height in pixels (default 24) */
export interface RowHeight {
  row: number;
  height: number;
}

/** The kind of link a CellLink represents.
 *  - "autofill": link to an AutoFillStore field (blue, editable, variants).
 *  - "formula":  link to a calculator FormulaEntry (brick-red). Sub-types:
 *    - constant link: cell value ↔ FormulaEntry.value (bidirectional).
 *    - function link: FormulaEntry.value → cell.computed (read-only cell).
 *    - matrix link:   cell range ↔ FormulaEntry.formula (matrix literal). */
export type CellLinkKind = "autofill" | "formula";

/** A cell link — connects table cell(s) to an auto-fill field OR a calculator
 *  formula. The cells are referenced by `cellIds` (stable IDs stored on
 *  Cell.linkId). For a single cell, cellIds has one element. For a range,
 *  multiple. */
export interface CellLink {
  /** Unique ID for this link (e.g. "CL001"). */
  id: string;
  /** The kind of link — autofill or formula. Defaults to "autofill" for
   *  backward compatibility with existing serialized data. */
  kind?: CellLinkKind;
  /** The auto-fill field ID (e.g. "AF007") in the document's AutoFillStore.
   *  Only set when kind === "autofill". */
  autoFillFieldId: string;
  /** The calculator formula ID (e.g. "F003") in the document's FormulaStore.
   *  Only set when kind === "formula". */
  formulaId?: string;
  /** Stable cell IDs — one per cell in the range. Matches Cell.linkId. */
  cellIds: string[];
  /** Label shown in the right panel. */
  label: string;
  /** Description for AI. */
  description: string;
}

/** A block in the right panel — extensible for future types.
 *  Each block is anchored to a specific row and renders at that row's
 *  vertical position in the right panel. */
export interface RightPanelBlock {
  /** Unique ID. */
  id: string;
  /** Block type — extensible for future block types (calculator vars, charts, etc.). */
  type: "autofill-link" | "calculator-var" | "chart" | "widget";
  /** The row this block is attached to (0-indexed). The block renders at the
   *  same vertical position as this row in the grid. */
  row: number;
  /** The cell link ID (for "autofill-link" type). */
  cellLinkId?: string;
  /** Type-specific data (extensible). */
  data?: Record<string, unknown>;
  /** Detached X offset from the boundary in pixels (0 = docked at boundary).
   *  When > 25, the block is visually detached with a connecting line.
   *  When <= 25, it snaps back to the boundary. */
  offsetX?: number;
  /** For "calculator-var" blocks: whether the LaTeX formula is shown next to
   *  the block button in the right panel. Toggled by a checkbox in the
   *  block's popover. When true, KaTeX renders the formula to the right. */
  showFormulaLatex?: boolean;
}

/** A complete table document — stored as an XML resource in .docs */
export interface TableDoc {
  /** Unique id like "T001" */
  id: string;
  /** User-assigned name (filesystem-safe) */
  name: string;
  /** Grid of cells: cells[row][col] */
  cells: (Cell | null)[][];
  /** Merged regions */
  merges: Merge[];
  /** Named zones for AI access */
  zones: NamedZone[];
  /** Cell links — auto-fill rules linked to specific cells. */
  cellLinks: CellLink[];
  /** Right panel blocks — visual elements anchored to table rows. */
  rightPanelBlocks: RightPanelBlock[];
  /** Per-column widths (overrides default) */
  colWidths: ColWidth[];
  /** Per-row heights (overrides default) */
  rowHeights: RowHeight[];
  /** Number of rows (for rendering empty grid) */
  rowCount: number;
  /** Number of columns */
  colCount: number;
  /** Creation timestamp */
  createdAt: string;
  updatedAt: string;
}

/** Selection state — either a single cell or a range */
export interface Selection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Clipboard data — TSV for Excel compat + internal format */
export interface ClipboardData {
  /** TSV string (tab-separated, newline rows) for Excel compat */
  tsv: string;
  /** 2D array of cell values (raw strings) */
  cells: string[][];
  /** 2D array of cell styles (parallel to cells) */
  styles: (CellStyle | null)[][];
}
