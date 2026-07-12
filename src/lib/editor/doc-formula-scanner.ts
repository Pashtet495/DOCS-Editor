// ============================================================================
// Document Formula Scanner — scans the ProseMirror document for LaTeX formula
// patterns ($...$, $$...$$, \(...\), \[...\]), registers found formulas in the
// FormulaStore, and replaces the LaTeX text with formulaBlock NODES (canvas
// elements) directly — NOT text markers.
// ============================================================================

import type { FormulaStore, FormulaEntry } from "./types";
import { nextFormulaId, recalculateFormulas } from "./formula-parser";

/** Result of a scan pass. */
export interface ScanResult {
  updatedStore: FormulaStore;
  foundCount: number;
  replacedCount: number;
}

/** Minimal typed view of the ProseMirror editor needed for scanning. */
interface EditorView {
  state: {
    doc: {
      descendants: (cb: (node: TextNode, pos: number) => boolean | void) => void;
    };
    tr: {
      insertText: (text: string, from: number, to?: number) => unknown;
      replaceWith: (from: number, to: number, content: unknown) => unknown;
    };
    schema: {
      nodes: {
        formulaBlock?: { create: (attrs: Record<string, unknown>) => unknown };
      };
    };
  };
  dispatch: (tr: unknown) => void;
}

interface TextNode {
  isText: boolean;
  text?: string;
}

/** LaTeX detection patterns (order matters: $$ before $). */
const LATEX_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\$\$([\s\S]+?)\$\$/g, name: "display-$$" },
  { re: /(?<!\$)\$([^$\n]+?)\$(?!\$)/g, name: "inline-$" },
  { re: /\\\(([\s\S]+?)\\\)/g, name: "inline-\\(\\)" },
  { re: /\\\[([\s\S]+?)\\\]/g, name: "display-\\[\\]" },
];

/** Default display settings for newly scanned formulas. */
export interface DefaultDisplaySettings {
  showDesignation: boolean;
  showFormula: boolean;
  showValue: boolean;
  showNumber: boolean;
  showDescription: boolean;
}

let defaultDisplaySettings: DefaultDisplaySettings = {
  showDesignation: true,
  showFormula: true,
  showValue: true,
  showNumber: true,
  showDescription: false,
};

/** Set the default display settings for newly scanned formulas. */
export function setDefaultDisplaySettings(settings: Partial<DefaultDisplaySettings>): void {
  defaultDisplaySettings = { ...defaultDisplaySettings, ...settings };
}

/** Get the current default display settings. */
export function getDefaultDisplaySettings(): DefaultDisplaySettings {
  return { ...defaultDisplaySettings };
}

/**
 * Scan the document for LaTeX formulas, register them in the formula store,
 * and replace the LaTeX text with formulaBlock NODES (canvas elements).
 *
 * @param editor The superdoc active editor (must have .view)
 * @param formulaStore Current formula store
 * @returns ScanResult, or null if the editor is not available
 */
export function scanAndRegisterFormulas(
  editor: unknown,
  formulaStore: FormulaStore,
): ScanResult | null {
  const ed = editor as {
    view?: EditorView;
  } | null;

  if (!ed?.view) return null;
  const view = ed.view;
  const formulaBlockType = view.state.schema.nodes?.formulaBlock;
  if (!formulaBlockType) {
    console.warn("[formula-scanner] no formulaBlock node type in schema");
    return null;
  }

  let updatedStore = formulaStore;
  const mods: Array<{ pos: number; oldTextLength: number; formulaNode: unknown }> = [];
  let foundCount = 0;

  try {
    view.state.doc.descendants((node: TextNode, pos: number) => {
      if (!node.isText || !node.text) return;
      const text = node.text;

      // Quick check: does the text contain any LaTeX delimiters?
      if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return;

      // Collect all formula matches with their positions in the text
      const matches: Array<{ start: number; end: number; latex: string }> = [];
      for (const { re } of LATEX_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const trimmedLatex = (m[1] || "").trim();
          if (!trimmedLatex) continue;
          matches.push({ start: m.index, end: m.index + m[0].length, latex: trimmedLatex });
        }
      }

      if (matches.length === 0) return;

      // Sort matches by position
      matches.sort((a, b) => a.start - b.start);

      // Process each match: register in store and create a formulaBlock node
      for (const match of matches) {
        const trimmedLatex = match.latex;

        // Check if formula already exists by content
        let entry = updatedStore.formulas.find((f) => f.formula === trimmedLatex);

        if (!entry) {
          const id = nextFormulaId(updatedStore.formulas);
          let fNum = parseInt(id.slice(1), 10);
          let name = `f${fNum}`;
          while (updatedStore.formulas.some((f) => f.name === name)) {
            fNum++;
            name = `f${fNum}`;
          }
          entry = {
            id,
            name,
            formula: trimmedLatex,
            userCreated: true,
            inDocument: true,
          };
          updatedStore = {
            ...updatedStore,
            formulas: [...updatedStore.formulas, entry],
          };
        } else if (!entry.inDocument) {
          updatedStore = {
            ...updatedStore,
            formulas: updatedStore.formulas.map((f) =>
              f.id === entry!.id ? { ...f, inDocument: true } : f,
            ),
          };
          entry = { ...entry, inDocument: true };
        }

        foundCount++;

        // Create a formulaBlock node for this formula
        const equationNumber = updatedStore.formulas.filter((f) => f.inDocument).length;
        const formulaNode = formulaBlockType.create({
          formulaId: entry.id,
          latex: entry.formula,
          designation: entry.name,
          value: entry.value,
          showDesignation: defaultDisplaySettings.showDesignation,
          showFormula: defaultDisplaySettings.showFormula,
          showValue: defaultDisplaySettings.showValue,
          showNumber: defaultDisplaySettings.showNumber,
          equationNumber,
          showDescription: defaultDisplaySettings.showDescription,
          descriptionText: "",
        });

        // The match position is relative to the text node.
        // We need to replace the LaTeX text with the formulaBlock node.
        mods.push({
          pos: pos + match.start,
          oldTextLength: match.end - match.start,
          formulaNode,
        });
      }
    });
  } catch (e) {
    console.warn("[formula-scanner] descendants failed", e);
    return null;
  }

  if (mods.length === 0) {
    return {
      updatedStore: { ...updatedStore, formulas: recalculateFormulas(updatedStore.formulas) },
      foundCount,
      replacedCount: 0,
    };
  }

  // Apply modifications in reverse order (last position first) to preserve positions.
  try {
    const tr = view.state.tr;
    for (let i = mods.length - 1; i >= 0; i--) {
      const { pos, oldTextLength, formulaNode } = mods[i];
      tr.replaceWith(pos, pos + oldTextLength, formulaNode);
    }
    view.dispatch(tr);
  } catch (e) {
    console.warn("[formula-scanner] dispatch failed", e);
  }

  return {
    updatedStore: { ...updatedStore, formulas: recalculateFormulas(updatedStore.formulas) },
    foundCount,
    replacedCount: mods.length,
  };
}
