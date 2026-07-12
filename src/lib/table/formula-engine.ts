// ============================================================================
// Formula Engine — evaluate spreadsheet formulas using math.js.
//
// Pure library: no React, no DOM. Safe to call from workers, tests, or server
// code. The single public entry point is `evaluateTable(cells)` which returns
// a NEW 2D array with `computed` and `error` fields filled in for every cell.
//
// Pipeline:
//   1. Compute non-formula cells (parse numbers, keep strings as-is).
//   2. Build a dependency graph of formula cells (only formula → formula
//      edges matter for cycle detection; non-formula cells are always
//      already computed in step 1).
//   3. Topological sort via Kahn's algorithm. Cells that never reach
//      in-degree 0 are part of (or downstream of) a cycle.
//   4. For each cyclic cell, find an actual cycle chain through DFS so the
//      error message can show "A1→B1→A1".
//   5. Evaluate formula cells in topological order:
//        - strip leading "="
//        - replace ranges (A1:B3) with JS array literals [v1, v2, ...]
//        - replace single cell refs (A1, $A$1) with their computed values
//        - call math.js evaluate
//        - normalize the result back into Cell.computed (string | number)
//      Errors propagate downstream: a cell that depends on an errored cell
//      also gets an error.
//
// Custom math.js instance:
//   math.js is case-sensitive for function names (SUM is undefined). We
//   register Excel-style uppercase aliases (SUM, AVERAGE, MIN, MAX, COUNT,
//   ABS, ROUND, …) plus a CONCATENATE function so users can do string concat
//   since math.js's `+` is numeric-only.
// ============================================================================

import { getMath, loadMath } from "@/lib/editor/math-loader";
import { letterToCol, colToLetter, parseCellRef } from "./cell-utils";
import type { Cell } from "./types";

// ---------------------------------------------------------------------------
// math.js instance + Excel function aliases
// ---------------------------------------------------------------------------
// IMPORTANT: math.js is loaded LAZILY from CDN via math-loader.ts (same as the
// rest of the project). We do NOT use `import { create, all } from "mathjs"`
// because that causes "Module not found" in Electron/Turbopack builds.
// The CDN script exposes `window.math` which is the full math.js instance.

let mathInstance: any = null;
let aliasesRegistered = false;

/** Get the math.js instance (from CDN), or null if not yet loaded. */
function getMathInstance(): any {
  if (mathInstance) return mathInstance;
  const m = getMath();
  if (m) {
    mathInstance = m;
    registerAliases();
    return mathInstance;
  }
  // Trigger async load — will be available on next call
  loadMath().catch(() => {});
  return null;
}

/** Flatten any combination of scalars, arrays, and math.js matrices into a
 *  single 1-D array of numbers (non-numbers dropped). Used by SUM-like
 *  functions that take variadic args + ranges. */
function flattenNumbers(args: unknown[]): number[] {
  const out: number[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) push(x);
    } else if (v && typeof v === "object" && "toArray" in v &&
               typeof (v as { toArray: () => unknown }).toArray === "function") {
      push((v as { toArray: () => unknown }).toArray());
    } else if (typeof v === "number" && isFinite(v)) {
      out.push(v);
    } else if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (!isNaN(n) && isFinite(n)) out.push(n);
    }
  };
  for (const a of args) push(a);
  return out;
}

/** Like flattenNumbers but keeps strings — used by COUNT/COUNTA/CONCATENATE. */
function flattenAll(args: unknown[]): unknown[] {
  const out: unknown[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) push(x);
    } else if (v && typeof v === "object" && "toArray" in v &&
               typeof (v as { toArray: () => unknown }).toArray === "function") {
      push((v as { toArray: () => unknown }).toArray());
    } else {
      out.push(v);
    }
  };
  for (const a of args) push(a);
  return out;
}

/** Register Excel-style uppercase function aliases on the math.js instance. */
function registerAliases() {
  if (aliasesRegistered || !mathInstance) return;
  aliasesRegistered = true;

  mathInstance.import(
    {
      SUM: (...args: unknown[]) => {
        const nums = flattenNumbers(args);
        return nums.reduce((a: number, b: number) => a + b, 0);
      },
      AVERAGE: (...args: unknown[]) => {
        const nums = flattenNumbers(args);
        if (nums.length === 0) return NaN;
        return nums.reduce((a: number, b: number) => a + b, 0) / nums.length;
      },
      AVE: (...args: unknown[]) => mathInstance.AVERAGE(...args),
      MIN: (...args: unknown[]) => {
        const nums = flattenNumbers(args);
        if (nums.length === 0) return 0;
        return Math.min(...nums);
      },
      MAX: (...args: unknown[]) => {
        const nums = flattenNumbers(args);
        if (nums.length === 0) return 0;
        return Math.max(...nums);
      },
      COUNT: (...args: unknown[]) => flattenNumbers(args).length,
      COUNTA: (...args: unknown[]) =>
        flattenAll(args).filter((v) => v !== null && v !== undefined && v !== "").length,
      PRODUCT: (...args: unknown[]) => {
        const nums = flattenNumbers(args);
        if (nums.length === 0) return 0;
        return nums.reduce((a: number, b: number) => a * b, 1);
      },
      ABS: (x: number) => Math.abs(x),
      ROUND: (x: number, digits = 0) => {
        const f = Math.pow(10, digits);
        return Math.round(x * f) / f;
      },
      CEILING: (x: number, sig = 1) => Math.ceil(x / sig) * sig,
      FLOOR: (x: number, sig = 1) => Math.floor(x / sig) * sig,
      INT: (x: number) => Math.floor(x),
      SQRT: (x: number) => Math.sqrt(x),
      POWER: (x: number, y: number) => Math.pow(x, y),
      MOD: (x: number, y: number) => x - y * Math.floor(x / y),
      EXP: (x: number) => Math.exp(x),
      LN: (x: number) => Math.log(x),
      LOG10: (x: number) => Math.log10(x),
      LOG: (x: number, base = 10) => Math.log(x) / Math.log(base),
      SIN: (x: number) => Math.sin(x),
      COS: (x: number) => Math.cos(x),
      TAN: (x: number) => Math.tan(x),
      ASIN: (x: number) => Math.asin(x),
      ACOS: (x: number) => Math.acos(x),
      ATAN: (x: number) => Math.atan(x),
      ATAN2: (y: number, x: number) => Math.atan2(y, x),
      PI: () => Math.PI,
      RAND: () => Math.random(),
      RANDBETWEEN: (lo: number, hi: number) =>
        Math.floor(Math.random() * (hi - lo + 1)) + lo,
      TRUNC: (x: number, digits = 0) => {
        const f = Math.pow(10, digits);
        return Math.trunc(x * f) / f;
      },
      SIGN: (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0),
      DEGREES: (x: number) => (x * 180) / Math.PI,
      RADIANS: (x: number) => (x * Math.PI) / 180,
      CONCATENATE: (...args: unknown[]) =>
        flattenAll(args)
          .map((v) => (v === null || v === undefined ? "" : String(v)))
          .join(""),
      CONCAT: (...args: unknown[]) =>
        flattenAll(args)
          .map((v) => (v === null || v === undefined ? "" : String(v)))
          .join(""),
      LEN: (s: unknown) => (s === null || s === undefined ? 0 : String(s).length),
      UPPER: (s: unknown) => String(s ?? "").toUpperCase(),
      LOWER: (s: unknown) => String(s ?? "").toLowerCase(),
      TRIM: (s: unknown) => String(s ?? "").trim(),
      IF: (cond: unknown, yes: unknown, no: unknown) => (cond ? yes : no),
      TRUE: () => true,
      FALSE: () => false,
      AND: (...args: unknown[]) => flattenAll(args).every(Boolean),
      OR: (...args: unknown[]) => flattenAll(args).some(Boolean),
      NOT: (x: unknown) => !x,
    },
    { override: true },
  );
}

// ---------------------------------------------------------------------------
// Public utilities
// ---------------------------------------------------------------------------

/** Check if a raw value is a formula (starts with "="). */
export function isFormula(raw: string): boolean {
  return typeof raw === "string" && raw.length > 1 && raw.startsWith("=");
}

/** Get the display value of a cell (computed if formula, raw otherwise).
 *  Errors surface as the error string so the UI can show them. */
export function getDisplayValue(cell: Cell | null): string {
  if (!cell) return "";
  // Cells managed by the calculator integration (formulaLinkId) show their
  // computed value (which comes from the global FormulaStore).
  if (cell.formulaLinkId) {
    if (cell.error) return cell.error;
    if (cell.computed === null || cell.computed === undefined) return "";
    return String(cell.computed);
  }
  if (isFormula(cell.raw)) {
    if (cell.error) return cell.error;
    if (cell.computed === null || cell.computed === undefined) return "";
    return String(cell.computed);
  }
  return cell.raw;
}

/**
 * Regex for cell references inside a formula.
 *
 * Matches `A1`, `$A$1`, `$A1`, `A$1`, and ranges `A1:B5` / `$A$1:$B$5`.
 *
 * Two safety lookarounds:
 *  - `(?<![A-Za-z0-9_])` — don't match in the middle of an identifier
 *    (e.g. the "A1" inside "fooA1" is not a cell ref).
 *  - `(?![A-Za-z0-9_(])` — don't match if immediately followed by a letter,
 *    digit, underscore, or `(`. The `(` excludes function calls like
 *    `LOG10(`, `ATAN2(`, `SUM(` (well, SUM has no digits, but LOG10 does).
 *
 * Note: `$A$1` — the lookbehind checks before the first `$`, which is fine
 * because `$` is not in `[A-Za-z0-9_]`.
 */
const CELL_REF_REGEX =
  /(?<![A-Za-z0-9_])\$?([A-Z]+)\$?(\d+)(?![A-Za-z0-9_(])(?::\$?([A-Z]+)\$?(\d+))?/g;

/** Extract all cell references from a formula string.
 *  Returns array of {row, col} (0-indexed). Handles A1, $A$1, A1:B5 ranges —
 *  for a range, every cell in the rectangle is returned. */
export function extractCellRefs(
  formula: string,
): Array<{ row: number; col: number }> {
  if (!formula) return [];
  // Strip leading "=" if present so it doesn't interfere.
  const expr = formula.startsWith("=") ? formula.slice(1) : formula;
  const refs: Array<{ row: number; col: number }> = [];

  // Reset lastIndex in case the regex was used before (it has /g).
  CELL_REF_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_REF_REGEX.exec(expr)) !== null) {
    const startCol = letterToCol(m[1]);
    const startRow = parseInt(m[2], 10) - 1;
    if (startCol < 0 || startRow < 0) continue;

    if (m[3] && m[4]) {
      // Range: expand to every cell in the rectangle.
      const endCol = letterToCol(m[3]);
      const endRow = parseInt(m[4], 10) - 1;
      if (endCol < 0 || endRow < 0) continue;
      const minRow = Math.min(startRow, endRow);
      const maxRow = Math.max(startRow, endRow);
      const minCol = Math.min(startCol, endCol);
      const maxCol = Math.max(startCol, endCol);
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          refs.push({ row: r, col: c });
        }
      }
    } else {
      refs.push({ row: startRow, col: startCol });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse a raw string into a number if it's a valid numeric literal,
 *  otherwise return the original string. Empty string stays empty string. */
function parseRawValue(raw: string): string | number {
  if (raw === "") return "";
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  // Number() accepts "42", "3.14", "1e5", "-7", but also "" (→0) and " " (→0)
  // and "Infinity" — guard those.
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!isNaN(n) && isFinite(n)) return n;
  }
  return raw;
}

/** Convert a cell's computed value into a math.js expression string.
 *  - null/undefined → "0" (empty cell treated as 0 in math, per spec)
 *  - number → its literal form
 *  - numeric string → its literal form (so "5" becomes 5, not "5")
 *  - other string → quoted with escaped quotes
 *  - boolean → "true"/"false" (math.js supports these literals) */
function valueToMathExpr(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return "0";
  if (typeof val === "number") {
    if (isNaN(val)) return "0";
    if (!isFinite(val)) return String(val); // Infinity / -Infinity
    return String(val);
  }
  if (typeof val === "boolean") return val ? "true" : "false";
  // String value: try numeric
  const s = String(val);
  if (s === "") return "0";
  const trimmed = s.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!isNaN(n) && isFinite(n)) return String(n);
  }
  // Quoted string with escaped quotes and backslashes.
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Normalize a math.js evaluation result into a Cell.computed value.
 *  - number → number (Infinity/NaN preserved as numbers)
 *  - string → string
 *  - boolean → "TRUE"/"FALSE" (Excel style)
 *  - Matrix/array → comma-joined string
 *  - other → String(...) */
function normalizeMathResult(val: unknown): string | number {
  if (val === null || val === undefined) return "";
  if (typeof val === "number") return val;
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (typeof val === "string") return val;
  // math.js DenseMatrix / SparseMatrix
  if (typeof val === "object" && val !== null) {
    const v = val as { toArray?: () => unknown; data?: unknown[] };
    let arr: unknown;
    if (typeof v.toArray === "function") arr = v.toArray();
    else if (Array.isArray(v.data)) arr = v.data;
    else arr = val;
    if (Array.isArray(arr)) {
      // Single-element array → unwrap (e.g. result of indexing A1:B1 in some contexts)
      if (arr.length === 1) return normalizeMathResult(arr[0]);
      return arr
        .map((x) =>
          Array.isArray(x) ? x.map(String).join(", ") : String(x),
        )
        .join(", ");
    }
  }
  return String(val);
}

const cellKey = (r: number, c: number): string => `${r},${c}`;
const keyToRef = (key: string): string => {
  const [r, c] = key.split(",").map(Number);
  return colToLetter(c) + (r + 1);
};

/** Substitute cell references in a formula expression with their computed
 *  values. Ranges (A1:B3) become JS array literals `[v1, v2, ...]` so that
 *  math.js functions like SUM can consume them. */
function substituteCellRefs(
  expr: string,
  getCell: (r: number, c: number) => Cell | null,
): string {
  CELL_REF_REGEX.lastIndex = 0;
  return expr.replace(
    CELL_REF_REGEX,
    (match, l1: string, d1: string, l2: string | undefined, d2: string | undefined) => {
      const startCol = letterToCol(l1);
      const startRow = parseInt(d1, 10) - 1;

      if (l2 && d2) {
        // Range: build a JS array literal of values.
        const endCol = letterToCol(l2);
        const endRow = parseInt(d2, 10) - 1;
        const minRow = Math.min(startRow, endRow);
        const maxRow = Math.max(startRow, endRow);
        const minCol = Math.min(startCol, endCol);
        const maxCol = Math.max(startCol, endCol);
        const values: string[] = [];
        for (let r = minRow; r <= maxRow; r++) {
          for (let c = minCol; c <= maxCol; c++) {
            const depCell = getCell(r, c);
            values.push(valueToMathExpr(depCell?.computed));
          }
        }
        return `[${values.join(", ")}]`;
      }
      // Single cell ref.
      const depCell = getCell(startRow, startCol);
      return valueToMathExpr(depCell?.computed);
    },
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate all formula cells in a table grid using math.js.
 *
 * @param cells 2D array of cells (cells[row][col]). Not mutated.
 * @returns A NEW 2D array with `computed` and `error` fields filled in.
 */
export function evaluateTable(cells: (Cell | null)[][]): (Cell | null)[][] {
  // Deep-clone the input (shallow per-cell clone is enough — we don't mutate
  // nested style objects). Nulls stay null.
  const result: (Cell | null)[][] = cells.map((row) =>
    row.map((cell) => (cell ? { ...cell } : null)),
  );

  const rowCount = result.length;
  const getCell = (r: number, c: number): Cell | null => {
    if (r < 0 || r >= rowCount) return null;
    const row = result[r];
    if (!row || c < 0 || c >= row.length) return null;
    return row[c];
  };

  // ===== Pass 1: compute non-formula cells =====
  for (let r = 0; r < rowCount; r++) {
    const row = result[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      if (isFormula(cell.raw)) continue;
      cell.computed = parseRawValue(cell.raw);
      cell.error = undefined;
    }
  }

  // ===== Pass 2: collect formula cells + dependency edges =====
  // Only formula → formula edges matter for cycle detection. Formula → plain
  // value is fine because plain cells are already computed in Pass 1.
  const formulaCells = new Map<
    string,
    { row: number; col: number; formula: string }
  >();
  const deps = new Map<string, Set<string>>(); // key → set of formula-cell keys

  for (let r = 0; r < rowCount; r++) {
    const row = result[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || !isFormula(cell.raw)) continue;
      // Skip cells managed by the calculator integration (formulaLinkId).
      // Their value comes from the global FormulaStore via
      // pushFormulaValuesToCells, not from the table formula engine.
      if (cell.formulaLinkId) continue;
      const key = cellKey(r, c);
      formulaCells.set(key, { row: r, col: c, formula: cell.raw });

      const refs = extractCellRefs(cell.raw);
      const depSet = new Set<string>();
      for (const ref of refs) {
        const depCell = getCell(ref.row, ref.col);
        if (depCell && isFormula(depCell.raw)) {
          depSet.add(cellKey(ref.row, ref.col));
        }
      }
      deps.set(key, depSet);
    }
  }

  // ===== Pass 3: topological sort (Kahn's algorithm) =====
  // Cells that never reach in-degree 0 are part of (or downstream of) a cycle.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  for (const key of formulaCells.keys()) inDegree.set(key, 0);
  for (const [key, depSet] of deps) {
    inDegree.set(key, depSet.size);
    for (const dep of depSet) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(key);
    }
  }

  const queue: string[] = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const dependent of dependents.get(key) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  const cyclicCells = new Set<string>();
  for (const key of formulaCells.keys()) {
    if (!order.includes(key)) cyclicCells.add(key);
  }

  // ===== Pass 4: find a cycle chain for each cyclic cell (for error msg) =====
  // DFS within the subgraph of cyclic cells. When we revisit a node already
  // on the current path, we've found a cycle.
  const cycleChains = new Map<string, string>();
  const findCycleFrom = (start: string): string[] | null => {
    const visited = new Set<string>();
    const path: string[] = [];
    const dfs = (curr: string): string[] | null => {
      visited.add(curr);
      path.push(curr);
      for (const dep of deps.get(curr) ?? []) {
        if (!cyclicCells.has(dep)) continue;
        const idx = path.indexOf(dep);
        if (idx !== -1) {
          // Cycle: path[idx..end] + dep (dep closes the loop).
          return path.slice(idx).concat(dep);
        }
        if (!visited.has(dep)) {
          const found = dfs(dep);
          if (found) return found;
        }
      }
      path.pop();
      return null;
    };
    return dfs(start);
  };

  for (const key of cyclicCells) {
    const cycle = findCycleFrom(key);
    if (cycle && cycle.length > 0) {
      const chain = cycle.map(keyToRef).join("\u2192"); // →
      cycleChains.set(key, `Циклическая зависимость: ${chain}`);
    } else {
      cycleChains.set(key, "Циклическая зависимость");
    }
  }

  // Mark cyclic cells with their error.
  for (const key of cyclicCells) {
    const info = formulaCells.get(key)!;
    const cell = result[info.row][info.col];
    if (cell) {
      cell.error = cycleChains.get(key);
      cell.computed = null;
    }
  }

  // ===== Pass 5: evaluate non-cyclic formula cells in topological order =====
  for (const key of order) {
    const info = formulaCells.get(key)!;
    const cell = result[info.row][info.col];
    if (!cell) continue;

    // If any direct formula dep has an error, propagate.
    let propagatedError: string | undefined;
    for (const depKey of deps.get(key) ?? []) {
      const depInfo = formulaCells.get(depKey);
      if (!depInfo) continue;
      const depCell = result[depInfo.row][depInfo.col];
      if (depCell && depCell.error) {
        propagatedError = depCell.error;
        break;
      }
    }
    if (propagatedError) {
      cell.error = propagatedError;
      cell.computed = null;
      continue;
    }

    // Evaluate: strip "=", substitute refs, call math.js.
    try {
      const m = getMathInstance();
      if (!m) {
        // math.js not yet loaded from CDN — mark as loading error
        cell.error = "Загрузка math.js...";
        cell.computed = null;
        continue;
      }
      const expr = cell.raw.startsWith("=") ? cell.raw.slice(1) : cell.raw;
      const mathExpr = substituteCellRefs(expr, getCell);
      const resultVal = m.evaluate(mathExpr);
      cell.computed = normalizeMathResult(resultVal);
      cell.error = undefined;
    } catch (e) {
      cell.error = e instanceof Error ? e.message : String(e);
      cell.computed = null;
    }
  }

  return result;
}

// Re-export cell-utils helpers that callers may want alongside the engine.
export { parseCellRef, letterToCol, colToLetter };
