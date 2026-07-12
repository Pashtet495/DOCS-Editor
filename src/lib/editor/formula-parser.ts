// ============================================================================
// LaTeX Formula Parser — unified formula/constant system.
//
// Document format: {{F001:value}} — marker + computed value in one string.
//   - User sees the value in the document.
//   - Marker F001 is preserved for recalculation.
//   - On export to DOCX/PDF: {{F001:3.14}} → 3.14 (marker stripped).
//   - On recalc: {{F001:old}} → {{F001:new}} (only value changes, marker stays).
//
// Flow:
//   1. parseDocumentFormulas() — finds $...$ AND {{F001:...}} in blocks
//   2. activateCalcMode() — replaces $...$ with {{F001:value}}
//   3. syncFormulaValues() — updates values in {{F001:old}} → {{F001:new}}
// ============================================================================

import type { Block, FormulaEntry, FormulaStore } from "./types";
import { textOfBlock } from "./pmMap";

/** Extract LaTeX formulas from a text string ($...$, $$...$$, \[...\], \(...\)). */
export function extractFormulas(text: string): string[] {
  const formulas: string[] = [];
  const displayDollar = text.match(/\$\$([^$]+?)\$\$/g);
  if (displayDollar) for (const m of displayDollar) formulas.push(m.slice(2, -2).trim());
  const displayBracket = text.match(/\\\[([^\]]+?)\\\]/g);
  if (displayBracket) for (const m of displayBracket) formulas.push(m.slice(2, -2).trim());
  const inlineParen = text.match(/\\\(([^)]+?)\\\)/g);
  if (inlineParen) for (const m of inlineParen) formulas.push(m.slice(2, -2).trim());
  const inlineDollar = text.match(/(?<!\$)\$(?!\$)([^$]+?)\$(?!\$)/g);
  if (inlineDollar) for (const m of inlineDollar) formulas.push(m.slice(1, -1).trim());
  return formulas;
}

/** Find all {{F001:...}} or {{F001}} markers in document blocks. */
export function findFormulaMarkers(blocks: Block[]): Array<{ blockId: string; formulaId: string; currentValue: string | null }> {
  const markers: Array<{ blockId: string; formulaId: string; currentValue: string | null }> = [];
  for (const block of blocks) {
    const text = textOfBlock(block);
    if (!text) continue;
    // Match {{F001}} or {{F001:value}}
    const matches = text.matchAll(/\{\{(F\d+)(?::([^}]*))?\}\}/g);
    for (const match of matches) {
      markers.push({ blockId: block.id, formulaId: match[1], currentValue: match[2] || null });
    }
  }
  return markers;
}

/** Scan blocks for LaTeX ($...$) AND existing {{F...}} markers. Creates/updates FormulaEntry[]. */
export function parseDocumentFormulas(blocks: Block[], existingFormulas: FormulaEntry[] = []): FormulaEntry[] {
  const entries: FormulaEntry[] = [...existingFormulas];
  const seen = new Set<string>();
  for (const e of entries) { if (e.latex) seen.add(e.latex); }

  // Track which formula IDs are referenced in the document.
  const docMarkers = findFormulaMarkers(blocks);
  const docFormulaIds = new Set(docMarkers.map(m => m.formulaId));

  // Mark existing formulas as inDocument if referenced.
  for (const e of entries) {
    e.inDocument = docFormulaIds.has(e.id);
  }

  // Scan for new $...$ formulas.
  blocks.forEach((block, i) => {
    const text = textOfBlock(block);
    if (!text || (!text.includes("$") && !text.includes("\\["))) return;
    const formulas = extractFormulas(text);
    for (const latex of formulas) {
      if (seen.has(latex)) {
        const existing = entries.find(e => e.latex === latex);
        if (existing) {
          existing.blockIds = existing.blockIds || [];
          if (!existing.blockIds.includes(block.id)) existing.blockIds.push(block.id);
          existing.inDocument = true;
        }
      } else {
        seen.add(latex);
        const nameMatch = latex.match(/^\\?([a-zA-Z][a-zA-Z0-9_]*)\s*=/);
        const name = nameMatch ? nameMatch[1] : `f${entries.length + 1}`;
        // Generate unique ID — find max F-number and increment.
        const maxFNum = entries
          .filter(e => e.id.startsWith("F") && /^F\d+$/.test(e.id))
          .reduce((max, e) => Math.max(max, parseInt(e.id.slice(1), 10)), 0);
        entries.push({
          id: `F${String(maxFNum + 1).padStart(3, "0")}`,
          name, formula: latex, latex,
          blockIds: [block.id], inDocument: true, userCreated: false,
        });
      }
    }
  });

  return entries;
}

/** Create the {{F001:value}} marker string for a formula. */
export function makeMarker(formula: FormulaEntry): string {
  const value = formula.value !== undefined ? formatVal(formula.value) : "?";
  return `{{${formula.id}:${value}}}`;
}

/** Format a number for display inside marker. */
function formatVal(val: number): string {
  if (isNaN(val)) return "?";
  return String(parseFloat(val.toPrecision(12)));
}

import { getMath, loadMath } from "./math-loader";

/** Recalculate all formula values using math.js for evaluation.
 *  Supports full math.js syntax: D^(1/2), sqrt(D), (-b-D^(1/2))/(2*a), etc.
 *  Also supports matrix/vector constants: a FormulaEntry whose formula is a
 *  matrix literal ([[1,2],[3,4]]) evaluates to a math.js Matrix object, which
 *  is placed in scope so other formulas can use it (e.g. det(M)).
 *  If math.js is not yet loaded, falls back to Function() and triggers async load.
 */
export function recalculateFormulas(formulas: FormulaEntry[]): FormulaEntry[] {
  const math = getMath();
  if (!math) {
    // Trigger async load for next time
    loadMath().catch(() => {});
    return recalculateFormulasFallback(formulas);
  }

  const visited = new Set<string>();
  // results holds either numbers or math.js Matrix objects (for matrix constants).
  const results: Record<string, unknown> = {};
  const stack = new Set<string>();

  function evaluate(f: FormulaEntry): unknown {
    if (visited.has(f.id)) return results[f.id];
    if (stack.has(f.id)) { results[f.id] = undefined; visited.add(f.id); return undefined; }
    stack.add(f.id);

    try {
      // Build scope from already-evaluated formulas.
      // Scope values can be numbers OR matrices.
      const scope: Record<string, unknown> = {};
      for (const other of formulas) {
        if (other.id !== f.id && results[other.id] !== undefined) {
          scope[other.name] = results[other.id];
        }
      }
      // Use math.js for evaluation — handles ^, sqrt(), fractions, matrices, etc.
      const val = math.evaluate(f.formula, scope);
      // Store the raw value (number or Matrix). Scalar extraction is done below.
      if (typeof val === "number") {
        results[f.id] = val;
      } else if (typeof val?.valueOf?.() === "number") {
        results[f.id] = val.valueOf();
      } else {
        // Matrix or other complex type — store as-is for scope use.
        results[f.id] = val;
      }
    } catch {
      results[f.id] = undefined;
    }
    stack.delete(f.id);
    visited.add(f.id);
    return results[f.id];
  }

  // First pass: evaluate with topological resolution
  const nameToValue: Record<string, unknown> = {};
  for (const f of formulas) {
    nameToValue[f.name] = evaluate(f);
  }

  // Second pass: re-evaluate with ALL values available (for multi-dependency formulas)
  visited.clear();
  const result = formulas.map((f) => {
    let value: number | undefined;
    try {
      const scope: Record<string, unknown> = {};
      for (const [name, val] of Object.entries(nameToValue)) {
        if (val !== undefined && name !== f.name) {
          scope[name] = val;
        }
      }
      const val = math.evaluate(f.formula, scope);
      // For the final FormulaEntry.value, only keep numbers (matrices stay
      // in `formula` as the literal — their value is re-derived on demand).
      if (typeof val === "number") {
        value = val;
      } else if (typeof val?.valueOf?.() === "number") {
        value = val.valueOf();
      } else {
        // Matrix result — value stays undefined; formula field has the literal.
        value = undefined;
      }
    } catch {
      value = undefined;
    }
    return { ...f, value };
  });

  return result;
}

/** Convert a formula expression to LaTeX using math.js parser.
 *  Handles sqrt→√, fractions, exponents, etc.
 *  If math.js is not yet loaded, returns the raw formula.
 */
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

/** Fallback recalculation using Function() — used when math.js is not available. */
function recalculateFormulasFallback(formulas: FormulaEntry[]): FormulaEntry[] {
  const visited = new Set<string>();
  const results: Record<string, number | undefined> = {};
  const stack = new Set<string>();

  function evaluate(f: FormulaEntry): number | undefined {
    if (visited.has(f.id)) return results[f.id];
    if (stack.has(f.id)) { results[f.id] = undefined; visited.add(f.id); return undefined; }
    stack.add(f.id);
    const parsed = parseFloat(f.formula);
    if (!isNaN(parsed) && isFinite(parsed) && !/[a-zA-Z]/.test(f.formula)) {
      results[f.id] = parsed; stack.delete(f.id); visited.add(f.id); return parsed;
    }
    try {
      let expr = f.formula;
      for (const other of formulas) {
        if (other.id !== f.id && results[other.id] !== undefined) {
          expr = expr.replace(new RegExp(`\\b${other.name}\\b`, "g"), String(results[other.id]));
        }
      }
      expr = expr
        .replace(/sqrt\(/g, "Math.sqrt(")
        .replace(/abs\(/g, "Math.abs(")
        .replace(/sin\(/g, "Math.sin(")
        .replace(/cos\(/g, "Math.cos(")
        .replace(/tan\(/g, "Math.tan(")
        .replace(/asin\(/g, "Math.asin(")
        .replace(/acos\(/g, "Math.acos(")
        .replace(/atan\(/g, "Math.atan(")
        .replace(/log\(/g, "Math.log10(")
        .replace(/ln\(/g, "Math.log(")
        .replace(/\^/g, "**")
        .replace(/\bpi\b/g, String(Math.PI))
        .replace(/\be\b/g, String(Math.E));
      const val = Function(`"use strict"; return (${expr})`)();
      results[f.id] = typeof val === "number" ? val : undefined;
    } catch { results[f.id] = undefined; }
    stack.delete(f.id); visited.add(f.id);
    return results[f.id];
  }

  const nameToValue: Record<string, number | undefined> = {};
  for (const f of formulas) { nameToValue[f.name] = evaluate(f); }

  visited.clear();
  return formulas.map((f) => {
    let value: number | undefined;
    try {
      let expr = f.formula;
      for (const [name, val] of Object.entries(nameToValue)) {
        if (val !== undefined && name !== f.name) {
          expr = expr.replace(new RegExp(`\\b${name}\\b`, "g"), String(val));
        }
      }
      expr = expr
        .replace(/sqrt\(/g, "Math.sqrt(")
        .replace(/abs\(/g, "Math.abs(")
        .replace(/sin\(/g, "Math.sin(")
        .replace(/cos\(/g, "Math.cos(")
        .replace(/tan\(/g, "Math.tan(")
        .replace(/asin\(/g, "Math.asin(")
        .replace(/acos\(/g, "Math.acos(")
        .replace(/atan\(/g, "Math.atan(")
        .replace(/log\(/g, "Math.log10(")
        .replace(/ln\(/g, "Math.log(")
        .replace(/\^/g, "**")
        .replace(/\bpi\b/g, String(Math.PI))
        .replace(/\be\b/g, String(Math.E));
      const val = Function(`"use strict"; return (${expr})`)();
      value = typeof val === "number" ? val : undefined;
    } catch { value = undefined; }
    return { ...f, value };
  });
}

/** Create empty FormulaStore with no default constants.
 *  pi and e are available as calculator buttons, not as formula store entries. */
export function createEmptyFormulaStore(): FormulaStore {
  return {
    formulas: [],
    history: [],
    settings: { resultFormat: "normal", angleUnit: "deg" },
  };
}

/** Generate the next available F-number id (e.g. "F003") given existing formulas. */
export function nextFormulaId(formulas: FormulaEntry[]): string {
  const maxFNum = formulas
    .filter((f) => /^F\d+$/.test(f.id))
    .reduce((max, f) => Math.max(max, parseInt(f.id.slice(1), 10)), 0);
  return `F${String(maxFNum + 1).padStart(3, "0")}`;
}
