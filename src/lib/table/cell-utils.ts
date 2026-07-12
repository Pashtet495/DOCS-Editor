// ============================================================================
// Cell Reference & Selection Utilities
//
// Pure functions for:
//  - converting between (row, col) and Excel-style cell refs like "A1" / "$A$1"
//  - checking merge regions and selection rectangles
//  - rewriting formula references when rows/columns are inserted
//
// No React, no DOM. Safe to use from workers, tests, or server-side code.
// ============================================================================

import type { Merge, Selection } from "./types";

/** Convert column index (0-based) to letter(s): 0->A, 25->Z, 26->AA, etc. */
export function colToLetter(col: number): string {
  if (col < 0 || !Number.isFinite(col)) return "";
  let n = col;
  let result = "";
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

/** Convert letter(s) to column index: A->0, Z->25, AA->26. Returns -1 if invalid. */
export function letterToCol(letters: string): number {
  if (!letters) return -1;
  const upper = letters.toUpperCase();
  let col = 0;
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    if (code < 65 || code > 90) return -1;
    col = col * 26 + (code - 64); // A=1, Z=26
  }
  return col - 1; // back to 0-indexed
}

/** Convert (row, col) to cell ref like "A1" (row is 1-indexed in refs). */
export function toCellRef(row: number, col: number): string {
  return colToLetter(col) + (row + 1);
}

/** Result of parsing a cell reference. */
export interface ParsedRef {
  /** 0-indexed row */
  row: number;
  /** 0-indexed column */
  col: number;
  /** true if the row part had a "$" prefix */
  rowAbs: boolean;
  /** true if the column part had a "$" prefix */
  colAbs: boolean;
}

/** Parse a cell ref like "A1" or "$A$1" into {row, col, rowAbs, colAbs}.
 *  Returns null if the ref is malformed. */
export function parseCellRef(ref: string): ParsedRef | null {
  if (!ref) return null;
  const m = /^(\$?)([A-Z]+)(\$?)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  const col = letterToCol(m[2]);
  if (col < 0) return null;
  return {
    col,
    row: parseInt(m[4], 10) - 1,
    colAbs: m[1] === "$",
    rowAbs: m[3] === "$",
  };
}

/** Check if a point (row, col) is inside a merge region. */
export function isInMerge(row: number, col: number, merge: Merge): boolean {
  return (
    row >= merge.row &&
    row < merge.row + merge.rowSpan &&
    col >= merge.col &&
    col < merge.col + merge.colSpan
  );
}

/** Find the merge that contains (row, col), if any. Returns the first match. */
export function findMergeAt(
  row: number,
  col: number,
  merges: Merge[],
): Merge | null {
  for (const m of merges) {
    if (isInMerge(row, col, m)) return m;
  }
  return null;
}

/** Normalize selection so start <= end (top-left <= bottom-right). */
export function normalizeSelection(sel: Selection): Selection {
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endRow: Math.max(sel.startRow, sel.endRow),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

/** Check if two selections overlap (inclusive of edges). */
export function selectionsOverlap(a: Selection, b: Selection): boolean {
  const na = normalizeSelection(a);
  const nb = normalizeSelection(b);
  // Two rectangles do NOT overlap if one is fully above/below/left/right of the other
  return !(
    na.endRow < nb.startRow ||
    na.startRow > nb.endRow ||
    na.endCol < nb.startCol ||
    na.startCol > nb.endCol
  );
}

/**
 * Rewrite cell references in a formula when rows/columns are inserted.
 * Mirrors Excel behavior:
 *  - Absolute refs ($A$1): shift if the insertion point is strictly before them
 *  - Relative refs (A1): shift if insertion point is strictly before them
 *  - Refs after the insertion point shift down/right by `count`
 *  - Refs at/before the insertion point stay unchanged
 *
 * @param formula   The formula string (e.g. "=A1+B2*$C$3"). A leading "=" is
 *                  optional; it is preserved in the output.
 * @param insertRow Row index where new row(s) inserted (-1 if col insert only)
 * @param insertCol Col index where new col(s) inserted (-1 if row insert only)
 * @param count     Number of rows/cols inserted
 * @returns Rewritten formula
 */
export function rewriteFormulaRefs(
  formula: string,
  insertRow: number,
  insertCol: number,
  count: number,
): string {
  if (!formula || count === 0) return formula;
  // Matches cell refs like A1, $A$1, $A1, A$1, AA10, etc.
  // Function names with digits (e.g. LOG10) will also match — known limitation.
  const cellRefRegex = /\b\$?([A-Z]+)\$?(\d+)\b/g;
  return formula.replace(
    cellRefRegex,
    (match: string, letters: string, digits: string) => {
      // Detect absolute markers from the original match string
      const colAbs = match.startsWith("$");
      const lettersIdx = match.indexOf(letters);
      const afterLetters = lettersIdx + letters.length;
      const rowAbs = match.indexOf("$", afterLetters) !== -1;

      const col = letterToCol(letters);
      const row = parseInt(digits, 10) - 1; // 0-indexed

      let newRow = row;
      let newCol = col;

      // Shift refs at or after the insertion point.
      // Inserting at `insertRow` means new rows appear BEFORE row `insertRow`,
      // so any ref to row >= insertRow must shift down by `count`.
      // Same for columns.
      if (insertRow !== -1 && row >= insertRow) {
        newRow = row + count;
      }
      if (insertCol !== -1 && col >= insertCol) {
        newCol = col + count;
      }

      return (
        (colAbs ? "$" : "") +
        colToLetter(newCol) +
        (rowAbs ? "$" : "") +
        (newRow + 1)
      );
    },
  );
}
