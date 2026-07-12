// ============================================================================
// calc-engine — global calculator variable system for the table editor.
//
// This module bridges the FormulaStore (calculator constants/functions) with
// the table editor. It provides:
//   - classifyFormula: determines if a FormulaEntry is a "constant" (no user
//     variable references) or a "function" (references other variables).
//   - getDependencies: walks the AST to find ALL transitive dependencies of a
//     function (e.g. root → discriminant → a, b, c).
//   - serializeMatrix / serializeVector: converts a cell range into a math.js
//     matrix/vector literal for storage in FormulaEntry.formula.
//   - detectMatrix: checks if a formula is a matrix/vector literal.
//
// Classification rule (per user spec):
//   - "a = 4"            → constant  (formula "4" has no variable refs)
//   - "x1 = D + 4"       → function  (formula references D)
//   - "M = [[1,2],[3,4]]"→ constant  (matrix literal, no variable refs)
// ============================================================================

import { getMath, loadMath } from "@/lib/editor/math-loader";
import type { FormulaEntry } from "@/lib/editor/types";
import type { Cell } from "@/lib/table/types";

/** Built-in math.js symbols that are NOT user variables. We check `math[sym]`
 *  at runtime, but this set covers the most common ones as a fast path. */
const MATH_BUILTINS = new Set([
  // Constants
  "pi", "e", "phi", "E", "PI", "tau", "i",
  // Functions — trig
  "sin", "cos", "tan", "sec", "csc", "cot",
  "asin", "acos", "atan", "asec", "acsc", "acot", "atan2",
  "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  // Functions — log / exp
  "log", "log10", "log2", "ln", "exp", "sqrt", "cbrt", "nthRoot",
  // Functions — misc
  "abs", "ceil", "floor", "round", "fix", "sign",
  "max", "min", "mean", "median", "mode", "std", "variance",
  "sum", "prod", "cumsum", "cumprod",
  "factorial", "gamma", "stirling",
  "random", "rand", "randInt",
  // Matrix / linear algebra
  "det", "inv", "transpose", "diag", "eye", "ones", "zeros",
  "matrix", "sparse", "size", "concat", "sort", "flatten",
  "dot", "cross", "norm", "trace", "kron", "reshape",
  // Rounding / units
  "gcd", "lcm", "mod", "pow",
  // Combinatorics
  "combinations", "permutations", "bellNumbers",
  // Type checks
  "isInteger", "isNegative", "isNumeric", "isPositive", "isZero",
]);

/** Cache for classifyFormula results, keyed by formula expression.
 *  math.parse + traverse is expensive, and classifyFormula is called on every
 *  render of FormulaBlock and in store action loops. The cache prevents
 *  repeated AST construction for the same formula string. */
const classifyCache = new Map<string, "constant" | "function">();

/** Classify a formula entry as "constant" or "function".
 *  - constant: formula has no user-variable references (only literals +
 *    built-in math functions/constants).
 *  - function: formula references at least one user-defined variable name.
 *  Results are cached by formula string (the classification only depends on
 *  the expression, not on the entry id or value). */
export function classifyFormula(entry: FormulaEntry): "constant" | "function" {
  const cacheKey = entry.formula;
  const cached = classifyCache.get(cacheKey);
  if (cached) return cached;

  const math = getMath();
  let result: "constant" | "function";
  if (!math) {
    // Trigger async load for next call.
    loadMath().catch(() => {});
    // Fallback heuristic: if the formula contains letters that aren't part of
    // known math function names, treat as function.
    result = hasUserVariableHeuristic(entry.formula) ? "function" : "constant";
  } else {
    try {
      const symbols = collectSymbols(entry.formula);
      result = "constant";
      for (const sym of symbols) {
        // Skip built-in math constants/functions.
        if (MATH_BUILTINS.has(sym)) continue;
        // Check if math.js knows this symbol as a built-in.
        if (typeof (math as Record<string, unknown>)[sym] !== "undefined") continue;
        // It's a user variable reference → function.
        result = "function";
        break;
      }
    } catch {
      // Parse error — treat as constant (raw literal).
      result = "constant";
    }
  }
  classifyCache.set(cacheKey, result);
  return result;
}

/** Heuristic fallback (used when math.js isn't loaded yet): a formula is a
 *  function if it contains an identifier that's not a known math builtin. */
function hasUserVariableHeuristic(formula: string): boolean {
  const matches = formula.match(/[a-zA-Z_][a-zA-Z0-9_]*/g);
  if (!matches) return false;
  for (const m of matches) {
    if (!MATH_BUILTINS.has(m) && !["E", "PI"].includes(m)) {
      return true;
    }
  }
  return false;
}

/** Collect all symbol names referenced in a formula expression. */
function collectSymbols(formula: string): Set<string> {
  const math = getMath();
  if (!math) return new Set();
  const symbols = new Set<string>();
  const node = math.parse(formula);
  // Traverse the AST and collect SymbolNode names.
  // Function calls are FunctionAssignmentNode / FunctionNode — their argument
  // symbols are collected, but the function name itself is a FunctionNode name.
  node.traverse((n: unknown) => {
    const nn = n as { type: string; name?: string; content?: unknown };
    if (nn.type === "SymbolNode" && nn.name) {
      symbols.add(nn.name);
    }
    // For FunctionNode, the function name is in `fn.name` — but traverse
    // visits the FunctionNode's args, not the fn itself as a SymbolNode.
    // We don't add function names (they're built-in or user functions).
  });
  return symbols;
}

/** Get ALL transitive dependencies of a formula entry.
 *  Walks up the dependency graph: for each symbol referenced in the formula,
 *  finds the matching FormulaEntry (by name) and recurses.
 *  Returns a list of FormulaEntry objects (excluding `entry` itself). */
export function getDependencies(
  entry: FormulaEntry,
  all: FormulaEntry[],
): FormulaEntry[] {
  const math = getMath();
  if (!math) {
    loadMath().catch(() => {});
    return getDependenciesHeuristic(entry, all);
  }
  const byName = new Map<string, FormulaEntry>();
  for (const a of all) {
    byName.set(a.name, a);
  }
  const result = new Map<string, FormulaEntry>();
  const visited = new Set<string>();

  function walk(e: FormulaEntry) {
    if (visited.has(e.id)) return;
    visited.add(e.id);
    let symbols: Set<string>;
    try {
      symbols = collectSymbols(e.formula);
    } catch {
      return;
    }
    for (const sym of symbols) {
      if (MATH_BUILTINS.has(sym)) continue;
      if (typeof (math as Record<string, unknown>)[sym] !== "undefined") continue;
      const dep = byName.get(sym);
      if (dep && dep.id !== entry.id && !result.has(dep.id)) {
        result.set(dep.id, dep);
        walk(dep);
      }
    }
  }

  walk(entry);
  return Array.from(result.values());
}

/** Fallback dependency resolution using regex symbol extraction. */
function getDependenciesHeuristic(
  entry: FormulaEntry,
  all: FormulaEntry[],
): FormulaEntry[] {
  const byName = new Map(all.map((a) => [a.name, a]));
  const result = new Map<string, FormulaEntry>();
  const visited = new Set<string>();

  function walk(e: FormulaEntry) {
    if (visited.has(e.id)) return;
    visited.add(e.id);
    const matches = e.formula.match(/[a-zA-Z_][a-zA-Z0-9_]*/g);
    if (!matches) return;
    for (const sym of matches) {
      if (MATH_BUILTINS.has(sym)) continue;
      const dep = byName.get(sym);
      if (dep && dep.id !== entry.id && !result.has(dep.id)) {
        result.set(dep.id, dep);
        walk(dep);
      }
    }
  }

  walk(entry);
  return Array.from(result.values());
}

/** Detect if a formula string is a matrix/vector literal (starts with `[`). */
export function isMatrixFormula(formula: string): boolean {
  const trimmed = formula.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

/** Serialize a 2D array of cells into a math.js matrix literal.
 *  e.g. [[1,2],[3,4]] → "[[1, 2], [3, 4]]"
 *  Empty/non-numeric cells become 0. */
export function serializeMatrix(cells: (Cell | null)[][]): string {
  if (cells.length === 0) return "[]";
  const rows = cells.map((row) => {
    const vals = (row || []).map((c) => cellToNumberStr(c));
    return `[${vals.join(", ")}]`;
  });
  return `[${rows.join(", ")}]`;
}

/** Serialize a flat array of cells into a math.js vector literal (1×N).
 *  e.g. [1,2,3] → "[[1, 2, 3]]" (a row vector) */
export function serializeVector(cells: (Cell | null)[]): string {
  const vals = cells.map((c) => cellToNumberStr(c));
  return `[[${vals.join(", ")}]]`;
}

/** Convert a cell to a numeric string for matrix serialization. */
function cellToNumberStr(cell: Cell | null): string {
  if (!cell) return "0";
  const v = cell.computed ?? cell.raw;
  if (v == null || v === "") return "0";
  const n = Number(v);
  if (isNaN(n) || !isFinite(n)) return "0";
  return String(n);
}

/** Parse a matrix literal formula into a 2D number array.
 *  Returns null if the formula is not a matrix literal or parsing fails. */
export function parseMatrixFormula(formula: string): number[][] | null {
  if (!isMatrixFormula(formula)) return null;
  const math = getMath();
  if (!math) return null;
  try {
    const val = math.evaluate(formula);
    // math.js returns a Matrix object; .toArray() gives nested arrays.
    const arr = typeof val?.toArray === "function" ? val.toArray() : val;
    if (!Array.isArray(arr)) return null;
    // Flatten one level if it's a 1D vector (math.js may return [1,2,3]).
    const rows = arr.map((row: unknown) => {
      if (Array.isArray(row)) return row.map((x) => Number(x));
      return [Number(row)];
    });
    return rows as number[][];
  } catch {
    return null;
  }
}

/** Get the dimensions [rows, cols] of a matrix formula, or null. */
export function getMatrixDimensions(formula: string): [number, number] | null {
  const m = parseMatrixFormula(formula);
  if (!m) return null;
  const rows = m.length;
  const cols = rows > 0 ? m[0].length : 0;
  return [rows, cols];
}

/** Format a FormulaEntry value for display in lists/UIs.
 *  - Numbers: localized string.
 *  - Matrices: "матрица R×C".
 *  - Undefined: "?". */
export function formatFormulaValue(entry: FormulaEntry): string {
  if (isMatrixFormula(entry.formula)) {
    const dims = getMatrixDimensions(entry.formula);
    if (dims) return `матрица ${dims[0]}×${dims[1]}`;
    return "матрица";
  }
  if (entry.value === undefined || entry.value === null) return "?";
  if (typeof entry.value === "number") {
    if (isNaN(entry.value)) return "?";
    return String(parseFloat(entry.value.toPrecision(12)));
  }
  return String(entry.value);
}

/** Generate the LaTeX representation of a formula using math.js parser.
 *  Falls back to the raw formula string if math.js isn't loaded. */
export function formulaToLatex(formula: string): string {
  const math = getMath();
  if (!math) {
    loadMath().catch(() => {});
    return formula;
  }
  try {
    const node = math.parse(formula);
    return node.toTex({ parenthesis: "auto" });
  } catch {
    return formula;
  }
}

/** Find empty cells in a column starting from a given row, for default
 *  placement of dependency links. Returns an array of {row, col} positions. */
export function findEmptyCellsBelow(
  cells: (Cell | null)[][],
  startRow: number,
  col: number,
  count: number,
): Array<{ row: number; col: number }> {
  const result: Array<{ row: number; col: number }> = [];
  let row = startRow + 1;
  while (result.length < count && row < 1000) {
    const cell = cells[row]?.[col];
    if (!cell || cell.raw === "" || cell.raw == null) {
      result.push({ row, col });
    }
    row++;
  }
  // If not enough empty cells found, just use sequential rows.
  while (result.length < count) {
    result.push({ row: startRow + 1 + result.length, col });
  }
  return result;
}
