// ============================================================================
// Formula Block Extension — a custom SuperDoc/ProseMirror node that renders
// an interactive canvas (NOT a static image) inside the document.
//
// The node stores the LaTeX source + display options as attributes, and its
// NodeView renders a live canvas using the same formula-renderer that produces
// the preview. When the formula is recalculated, the canvas re-renders in
// place — no image swap needed.
//
// Registration: passed to `new SuperDoc({ editorExtensions: [formulaBlockNode] })`
// ============================================================================

import { defineNode, Extensions } from "@harbour-enterprises/superdoc";
import type { NodeView } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import type { Decoration, DecorationSource } from "prosemirror-view";
// EditorView type is imported separately to avoid pulling in the runtime module
// (which can cause duplicate ProseMirror instances when bundled alongside superdoc).
type EditorView = { state: { schema: { nodes: Record<string, { create: (attrs: Record<string, unknown>) => PmNode }> }; tr: { insert: (pos: number, node: PmNode) => unknown; setNodeMarkup: (pos: number, type: unknown, attrs: Record<string, unknown>) => unknown; scrollIntoView: () => unknown }; doc: { content: { size: number }; descendants: (cb: (node: PmNode, pos: number) => boolean | void) => void } }; dispatch: (tr: unknown) => void };
import { renderFormula } from "./formula-renderer";
import type { FormulaStore, FormulaEntry } from "./types";

// Global registry of formula stores — the NodeView reads from here to get the
// current FormulaStore (since ProseMirror NodeViews don't have direct access
// to the React/Zustand store).
const formulaStoreRegistry = new Map<string, FormulaStore>();

/** Register a formula store for a given editor id (called from the bridge). */
export function registerFormulaStore(editorId: string, store: FormulaStore): void {
  formulaStoreRegistry.set(editorId, store);
}

/** Unregister a formula store. */
export function unregisterFormulaStore(editorId: string): void {
  formulaStoreRegistry.delete(editorId);
}

/** The editor id whose store is currently active (set by the bridge). */
let activeEditorId = "default";

/** Set the active editor id (so NodeViews know which store to read). */
export function setActiveEditorId(id: string): void {
  activeEditorId = id;
}

// ============================================================================
// NodeView — renders the formula as an interactive canvas
// ============================================================================

class FormulaBlockNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;
  private canvas: HTMLCanvasElement;
  private editBtn: HTMLButtonElement;
  private node: PmNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private editorId: string;

  constructor(props: {
    node: PmNode;
    view: EditorView;
    getPos: () => number | undefined;
    decorations: readonly Decoration[];
    innerDecorations: DecorationSource;
  }) {
    this.node = props.node;
    this.view = props.view;
    this.getPos = props.getPos;
    this.editorId = activeEditorId;

    this.dom = document.createElement("div");
    this.dom.className = "formula-block";
    this.dom.style.cssText = "display: block; margin: 8px 0; text-align: center; position: relative;";
    this.dom.setAttribute("data-formula-block", "");
    this.dom.setAttribute("data-formula-id", this.node.attrs.formulaId || "");
    this.dom.contentEditable = "false";

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "max-width: 100%; display: inline-block; background: #ffffff;";
    this.dom.appendChild(this.canvas);

    // Add edit button (shown on hover/click)
    this.editBtn = document.createElement("button");
    this.editBtn.innerHTML = "✎";
    this.editBtn.style.cssText = "position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; border: 1px solid #ccc; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; display: none; z-index: 10;";
    this.editBtn.title = "Редактировать формулу";
    this.editBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const formulaId = this.node.attrs.formulaId as string;
      if (formulaId) {
        // Dispatch a custom event that the React layer can listen for
        this.dom.dispatchEvent(new CustomEvent("formula-edit", {
          detail: { formulaId },
          bubbles: true,
        }));
      }
    });
    this.dom.appendChild(this.editBtn);

    // Show edit button on hover
    this.dom.addEventListener("mouseenter", () => {
      this.editBtn.style.display = "block";
    });
    this.dom.addEventListener("mouseleave", () => {
      this.editBtn.style.display = "none";
    });

    this.render();
  }

  /** Render the formula onto the canvas. Uses cached dataUrl if available;
   *  otherwise calls renderFormula to generate it and caches the result. */
  private async render(): Promise<void> {
    const attrs = this.node.attrs as {
      latex: string;
      designation: string;
      value?: number;
      showDesignation: boolean;
      showFormula: boolean;
      showValue: boolean;
      showNumber: boolean;
      equationNumber: number;
      showDescription: boolean;
      descriptionText: string;
      formulaId: string;
      cachedDataUrl: string;
      cachedWidth: number;
      cachedHeight: number;
    };

    if (!attrs.latex && !attrs.designation) {
      this.canvas.width = 100;
      this.canvas.height = 40;
      const ctx = this.canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#fee2e2";
        ctx.fillRect(0, 0, 100, 40);
        ctx.fillStyle = "#991b1b";
        ctx.font = "12px sans-serif";
        ctx.fillText("Empty formula", 8, 24);
      }
      return;
    }

    // If we have a cached dataUrl, use it directly (no re-rendering needed).
    if (attrs.cachedDataUrl && attrs.cachedWidth > 0 && attrs.cachedHeight > 0) {
      const img = new Image();
      img.onload = () => {
        this.canvas.width = attrs.cachedWidth;
        this.canvas.height = attrs.cachedHeight;
        const ctx = this.canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, attrs.cachedWidth, attrs.cachedHeight);
          ctx.drawImage(img, 0, 0, attrs.cachedWidth, attrs.cachedHeight);
        }
      };
      img.src = attrs.cachedDataUrl;
      return;
    }

    // No cache — render from scratch and cache the result.
    try {
      const store = formulaStoreRegistry.get(this.editorId) || null;
      const formula: FormulaEntry | null = store
        ? store.formulas.find((f) => f.id === attrs.formulaId) || null
        : null;

      const { dataUrl, width, height } = await renderFormula({
        latex: attrs.latex,
        designation: attrs.designation,
        value: attrs.value,
        showDesignation: attrs.showDesignation,
        showFormula: attrs.showFormula,
        showValue: attrs.showValue,
        showNumber: attrs.showNumber,
        equationNumber: attrs.equationNumber,
        showDescription: attrs.showDescription,
        descriptionText: attrs.descriptionText || undefined,
        formulaStore: store,
        formula,
      });

      if (!dataUrl) return;

      // Cache the rendered dataUrl in the node's attributes.
      this.updateAttributes({
        cachedDataUrl: dataUrl,
        cachedWidth: width,
        cachedHeight: height,
      });

      // Draw the rendered PNG onto the canvas.
      const img = new Image();
      img.onload = () => {
        this.canvas.width = width;
        this.canvas.height = height;
        const ctx = this.canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
        }
      };
      img.src = dataUrl;
    } catch (e) {
      console.error("[FormulaBlockNodeView] render failed", e);
    }
  }

  /** Update node attributes via ProseMirror transaction. */
  private updateAttributes(attrs: Record<string, unknown>): void {
    const pos = this.getPos();
    if (pos == null) return;
    try {
      const tr = this.view.state.tr;
      tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs });
      this.view.dispatch(tr);
    } catch { /* ignore */ }
  }

  /** Called by ProseMirror when the node's attributes change. */
  update(node: PmNode, decorations: readonly Decoration[], innerDecorations: DecorationSource): boolean {
    if (node.type !== this.node.type) return false;
    const oldAttrs = this.node.attrs as Record<string, unknown>;
    const newAttrs = node.attrs as Record<string, unknown>;
    this.node = node;

    // Check if any relevant attribute changed (including cachedDataUrl clearing).
    const keys = ["latex", "designation", "value", "showDesignation", "showFormula", "showValue", "showNumber", "equationNumber", "showDescription", "descriptionText", "formulaId", "cachedDataUrl", "cachedWidth", "cachedHeight"];
    let changed = false;
    for (const k of keys) {
      if (oldAttrs[k] !== newAttrs[k]) { changed = true; break; }
    }
    if (changed) {
      this.dom.setAttribute("data-formula-id", newAttrs.formulaId as string || "");
      this.render();
    }
    return true;
  }

  /** Ignore DOM mutations — we own the canvas. */
  ignoreMutation(): boolean {
    return true;
  }

  /** Stop ProseMirror from intercepting pointer events on our canvas. */
  stopEvent(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.remove();
  }
}

// ============================================================================
// Node definition — registered via editorExtensions
// ============================================================================

export const formulaBlockNode = defineNode({
  name: "formulaBlock",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      formulaId: {
        default: null,
        renderDOM: (attrs: { formulaId?: string }) =>
          attrs.formulaId ? { "data-formula-id": attrs.formulaId } : {},
      },
      latex: {
        default: "",
        rendered: false,
      },
      designation: {
        default: "",
        rendered: false,
      },
      value: {
        default: undefined,
        rendered: false,
      },
      showDesignation: {
        default: true,
        rendered: false,
      },
      showFormula: {
        default: true,
        rendered: false,
      },
      showValue: {
        default: true,
        rendered: false,
      },
      showNumber: {
        default: true,
        rendered: false,
      },
      equationNumber: {
        default: 1,
        rendered: false,
      },
      showDescription: {
        default: false,
        rendered: false,
      },
      descriptionText: {
        default: "",
        rendered: false,
      },
      cachedDataUrl: {
        default: "",
        rendered: false,
      },
      cachedWidth: {
        default: 0,
        rendered: false,
      },
      cachedHeight: {
        default: 0,
        rendered: false,
      },
    };
  },

  parseDOM() {
    return [
      { tag: "div[data-formula-block]" },
    ];
  },

  renderDOM({ htmlAttributes }: { htmlAttributes: Record<string, unknown> }) {
    return [
      "div",
      Extensions.Attribute.mergeAttributes(htmlAttributes, {
        "data-formula-block": "",
        contenteditable: "false",
        style: "display: block; margin: 8px 0; text-align: center;",
      }),
    ];
  },

  addNodeView() {
    return (props) => new FormulaBlockNodeView(props);
  },
});

// ============================================================================
// Helper — insert a formula block via ProseMirror transaction
// ============================================================================

/** Insert a formula block node into the editor at the given position (or end). */
export function insertFormulaBlock(
  editor: unknown,
  opts: {
    formulaId: string;
    latex: string;
    designation?: string;
    value?: number;
    showDesignation?: boolean;
    showFormula?: boolean;
    showValue?: boolean;
    showNumber?: boolean;
    equationNumber?: number;
    showDescription?: boolean;
    descriptionText?: string;
    position?: number | "end";
  },
): boolean {
  const ed = editor as {
    view?: {
      state: {
        schema: {
          nodes: { formulaBlock?: { create: (attrs: Record<string, unknown>) => PmNode } };
        };
        tr: {
          insert: (pos: number, node: PmNode) => unknown;
          scrollIntoView: () => unknown;
        };
        doc: { content: { size: number } };
      };
      dispatch: (tr: unknown) => void;
    };
  } | null;

  if (!ed?.view) {
    console.error("[insertFormulaBlock] editor.view not available");
    return false;
  }

  const view = ed.view;
  const formulaBlockType = view.state.schema.nodes.formulaBlock;
  if (!formulaBlockType) {
    console.error("[insertFormulaBlock] formulaBlock node type not in schema");
    return false;
  }

  const node = formulaBlockType.create({
    formulaId: opts.formulaId,
    latex: opts.latex,
    designation: opts.designation || "",
    value: opts.value,
    showDesignation: opts.showDesignation ?? true,
    showFormula: opts.showFormula ?? true,
    showValue: opts.showValue ?? true,
    showNumber: opts.showNumber ?? true,
    equationNumber: opts.equationNumber ?? 1,
    showDescription: opts.showDescription ?? false,
    descriptionText: opts.descriptionText || "",
  });

  const pos = opts.position === "end" || opts.position === undefined
    ? view.state.doc.content.size
    : opts.position;

  try {
    view.dispatch(view.state.tr.insert(pos, node).scrollIntoView());
    return true;
  } catch (e) {
    console.error("[insertFormulaBlock] dispatch failed", e);
    return false;
  }
}

/** Update a formula block's attributes (e.g., when the value is recalculated). */
export function updateFormulaBlocks(
  editor: unknown,
  formulaId: string,
  updates: Record<string, unknown>,
): void {
  const ed = editor as {
    view?: {
      state: {
        doc: {
          descendants: (cb: (node: PmNode, pos: number) => boolean | void) => void;
        };
        tr: {
          setNodeMarkup: (pos: number, type: unknown, attrs: Record<string, unknown>) => unknown;
        };
        schema: { nodes: { formulaBlock?: unknown } };
      };
      dispatch: (tr: unknown) => void;
    };
  } | null;

  if (!ed?.view) return;
  const view = ed.view;

  try {
    const tr = view.state.tr;
    let found = false;
    view.state.doc.descendants((node: PmNode, pos: number) => {
      if (node.type.name === "formulaBlock" && node.attrs.formulaId === formulaId) {
        const newAttrs = { ...node.attrs, ...updates };
        tr.setNodeMarkup(pos, undefined, newAttrs);
        found = true;
      }
    });
    if (found) view.dispatch(tr);
  } catch (e) {
    console.error("[updateFormulaBlocks] failed", e);
  }
}

// ============================================================================
// Export/Import helpers — replace formulaBlock nodes with text markers before
// DOCX export (formulaBlock has no DOCX translation), and restore them after.
// Also: render formulaBlock nodes as images for view mode.
// ============================================================================

/** Marker format: [[FORMULA:formulaId:latex:display:showNumber:equationNumber:showDescription:descriptionText]] */
const MARKER_PREFIX = "[[FORMULA:";
const MARKER_SUFFIX = "]]";

/** Encode formulaBlock attrs into a text marker using base64 JSON.
 *  This avoids delimiter conflicts with special characters in LaTeX formulas
 *  (backslashes, pipes, braces, etc.) that would corrupt the marker during
 *  DOCX round-trip.
 */
function encodeFormulaMarker(attrs: Record<string, unknown>): string {
  const data = {
    formulaId: String(attrs.formulaId || ""),
    latex: String(attrs.latex || ""),
    designation: String(attrs.designation || ""),
    value: attrs.value,
    showDesignation: attrs.showDesignation ?? true,
    showFormula: attrs.showFormula ?? true,
    showValue: attrs.showValue ?? true,
    showNumber: attrs.showNumber ?? true,
    equationNumber: attrs.equationNumber ?? 1,
    showDescription: attrs.showDescription ?? false,
    descriptionText: String(attrs.descriptionText || ""),
  };
  // Base64-encode the JSON to survive DOCX round-trips without corruption
  const json = JSON.stringify(data);
  const b64 = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(json)))
    : Buffer.from(json, "utf8").toString("base64");
  return MARKER_PREFIX + b64 + MARKER_SUFFIX;
}

/** Decode a text marker back into formulaBlock attrs. */
function decodeFormulaMarker(marker: string): Record<string, unknown> | null {
  if (!marker.startsWith(MARKER_PREFIX) || !marker.endsWith(MARKER_SUFFIX)) return null;
  const b64 = marker.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length);
  try {
    const json = typeof atob === "function"
      ? decodeURIComponent(escape(atob(b64)))
      : Buffer.from(b64, "base64").toString("utf8");
    const data = JSON.parse(json);
    return {
      formulaId: data.formulaId,
      latex: data.latex,
      designation: data.designation || "",
      value: data.value,
      showDesignation: data.showDesignation ?? true,
      showFormula: data.showFormula ?? true,
      showValue: data.showValue ?? true,
      showNumber: data.showNumber ?? true,
      equationNumber: data.equationNumber ?? 1,
      showDescription: data.showDescription ?? false,
      descriptionText: data.descriptionText || "",
    };
  } catch {
    return null;
  }
}

/** Marker regex to find formula markers in text. */
const MARKER_RE = /\[\[FORMULA:[A-Za-z0-9+/=]+\]\]/g;

/**
 * Replace ALL formulaBlock nodes with text markers (paragraphs containing
 * the marker text). This makes the document safe for DOCX export.
 * Returns the number of replaced blocks.
 */
export function replaceFormulaBlocksWithMarkers(editor: unknown): number {
  const ed = editor as {
    view?: {
      state: {
        doc: {
          descendants: (cb: (node: PmNode, pos: number) => boolean | void) => void;
        };
        tr: {
          replaceWith: (from: number, to: number, content: unknown) => unknown;
        };
        schema: {
          nodes: {
            paragraph?: { create: (attrs?: Record<string, unknown>, content?: unknown) => PmNode };
            text?: { create: (attrs: Record<string, unknown>) => PmNode };
          };
        };
      };
      dispatch: (tr: unknown) => void;
    };
  } | null;

  if (!ed?.view) return 0;
  const view = ed.view;
  const paragraphType = view.state.schema.nodes.paragraph;
  const schema = view.state.schema;
  if (!paragraphType) return 0;

  // Collect all formulaBlock nodes (in reverse order so positions don't shift)
  const formulaBlocks: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
  view.state.doc.descendants((node: PmNode, pos: number) => {
    if (node.type.name === "formulaBlock") {
      formulaBlocks.push({ pos, attrs: node.attrs as Record<string, unknown> });
    }
  });

  if (formulaBlocks.length === 0) return 0;

  // Process in reverse order to keep positions valid
  formulaBlocks.reverse();
  for (const { pos, attrs } of formulaBlocks) {
    const marker = encodeFormulaMarker(attrs);
    // Create text node via schema.text() (ProseMirror API for text nodes)
    const textNode = schema.text(marker);
    const paragraphNode = paragraphType.create({}, textNode);
    const tr = view.state.tr;
    tr.replaceWith(pos, pos + 1, paragraphNode);
    view.dispatch(tr);
  }

  console.log("[replaceFormulaBlocksWithMarkers] replaced", formulaBlocks.length, "blocks with markers");
  return formulaBlocks.length;
}

/**
 * Restore formulaBlock nodes from text markers in the document.
 * Scans all text nodes for [[FORMULA:...]] markers and replaces the
 * containing paragraph with a formulaBlock node.
 * Returns the number of restored blocks.
 */
export function restoreFormulaBlocksFromMarkers(editor: unknown): number {
  const ed = editor as {
    view?: {
      state: {
        doc: {
          descendants: (cb: (node: PmNode, pos: number, parent: unknown) => boolean | void) => void;
          textBetween: (from: number, to: number) => string;
        };
        tr: {
          replaceWith: (from: number, to: number, content: unknown) => unknown;
        };
        schema: {
          nodes: {
            formulaBlock?: { create: (attrs: Record<string, unknown>) => PmNode };
            paragraph?: { name: string };
          };
        };
      };
      dispatch: (tr: unknown) => void;
    };
  } | null;

  if (!ed?.view) return 0;
  const view = ed.view;
  const formulaBlockType = view.state.schema.nodes.formulaBlock;
  if (!formulaBlockType) return 0;

  // Collect all paragraphs that contain formula markers
  const markers: Array<{ pos: number; text: string; nodeSize: number }> = [];
  view.state.doc.descendants((node: PmNode, pos: number) => {
    if (node.type.name === "paragraph") {
      try {
        const text = (node as unknown as { textContent?: string }).textContent || "";
        if (text.includes(MARKER_PREFIX)) {
          const match = text.match(MARKER_RE);
          if (match) {
            for (const m of match) {
              markers.push({ pos, text: m, nodeSize: node.nodeSize });
            }
          }
        }
      } catch { /* skip */ }
    }
  });

  if (markers.length === 0) return 0;

  // Process in reverse order
  markers.reverse();
  let count = 0;
  for (const { pos, text, nodeSize } of markers) {
    const attrs = decodeFormulaMarker(text);
    if (!attrs) continue;
    try {
      const formulaNode = formulaBlockType.create(attrs);
      const tr = view.state.tr;
      // Replace the ENTIRE paragraph (pos to pos + nodeSize) with the formulaBlock
      tr.replaceWith(pos, pos + nodeSize, formulaNode);
      view.dispatch(tr);
      count++;
    } catch (e) {
      console.error("[restoreFormulaBlocksFromMarkers] failed", e);
    }
  }

  console.log("[restoreFormulaBlocksFromMarkers] restored", count, "blocks from markers");
  return count;
}

/**
 * Render ALL formulaBlock nodes as images and replace them.
 * Also handles text markers ([[FORMULA:...]]) — if the document has markers
 * instead of formulaBlock nodes (e.g., after exportDocx), they are decoded
 * and replaced with images.
 * Used when switching to view mode (where custom node views don't work).
 */
export async function replaceFormulaBlocksWithImages(editor: unknown): Promise<number> {
  const ed = editor as {
    view?: {
      state: {
        doc: {
          descendants: (cb: (node: PmNode, pos: number) => boolean | void) => void;
          textBetween?: (from: number, to: number) => string;
        };
        tr: {
          replaceWith: (from: number, to: number, content: unknown) => unknown;
        };
        schema: {
          nodes: {
            image?: { create: (attrs: Record<string, unknown>) => PmNode };
          };
        };
      };
      dispatch: (tr: unknown) => void;
    };
  } | null;

  if (!ed?.view) return 0;
  const view = ed.view;
  const imageType = view.state.schema.nodes.image;
  if (!imageType) return 0;

  // Collect both formulaBlock nodes AND text markers
  const targets: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
  view.state.doc.descendants((node: PmNode, pos: number) => {
    if (node.type.name === "formulaBlock") {
      targets.push({ pos, attrs: node.attrs as Record<string, unknown> });
    } else if (node.type.name === "paragraph") {
      // Check for text markers in the paragraph
      try {
        const text = (node as unknown as { textContent?: string }).textContent || "";
        if (text.includes(MARKER_PREFIX)) {
          const matches = text.match(MARKER_RE);
          if (matches) {
            for (const m of matches) {
              const attrs = decodeFormulaMarker(m);
              if (attrs) targets.push({ pos, attrs });
            }
          }
        }
      } catch { /* skip */ }
    }
  });

  if (targets.length === 0) {
    console.log("[replaceFormulaBlocksWithImages] no formulaBlock nodes or markers found");
    return 0;
  }

  const { renderFormula } = await import("./formula-renderer");
  targets.reverse();

  let count = 0;
  for (const { pos, attrs } of targets) {
    try {
      const { dataUrl } = await renderFormula({
        latex: attrs.latex as string,
        value: attrs.value as number | undefined,
        display: (attrs.display as "formula" | "value" | "both") || "both",
        showNumber: attrs.showNumber as boolean,
        equationNumber: attrs.equationNumber as number,
        showDescription: attrs.showDescription as boolean,
        descriptionText: attrs.descriptionText as string,
      });
      if (!dataUrl) continue;

      const imageNode = imageType.create({
        src: dataUrl,
        alt: `[formula:${attrs.formulaId}]`,
      });
      const tr = view.state.tr;
      tr.replaceWith(pos, pos + 1, imageNode);
      view.dispatch(tr);
      count++;
    } catch (e) {
      console.error("[replaceFormulaBlocksWithImages] failed", e);
    }
  }

  console.log("[replaceFormulaBlocksWithImages] replaced", count, "blocks with images");
  return count;
}

// ============================================================================
// Formula block data export/import — store canvas data in .docs file
// ============================================================================

export interface FormulaBlockData {
  formulaId: string;
  latex: string;
  value?: number;
  display: string;
  showNumber: boolean;
  equationNumber: number;
  showDescription: boolean;
  descriptionText: string;
  cachedDataUrl: string;
  cachedWidth: number;
  cachedHeight: number;
}

/** Collect all formulaBlock node data from the editor (for .docs persistence). */
export function collectFormulaBlockData(editor: unknown): FormulaBlockData[] {
  const ed = editor as {
    view?: {
      state: {
        doc: {
          descendants: (cb: (node: PmNode, pos: number) => boolean | void) => void;
        };
      };
    };
  } | null;

  if (!ed?.view) return [];
  const data: FormulaBlockData[] = [];
  ed.view.state.doc.descendants((node: PmNode) => {
    if (node.type.name === "formulaBlock") {
      const a = node.attrs as Record<string, unknown>;
      data.push({
        formulaId: String(a.formulaId || ""),
        latex: String(a.latex || ""),
        value: a.value as number | undefined,
        display: String(a.display || "both"),
        showNumber: a.showNumber !== false,
        equationNumber: Number(a.equationNumber || 1),
        showDescription: a.showDescription === true,
        descriptionText: String(a.descriptionText || ""),
        cachedDataUrl: String(a.cachedDataUrl || ""),
        cachedWidth: Number(a.cachedWidth || 0),
        cachedHeight: Number(a.cachedHeight || 0),
      });
    }
  });
  return data;
}

/** Insert formulaBlock nodes from saved data into the editor.
 *  Scans for text markers ([[FORMULA:...]]) and replaces them with
 *  formulaBlock nodes that include the cached canvas data.
 */
export function restoreFormulaBlocksFromData(
  editor: unknown,
  blocksData: FormulaBlockData[],
): number {
  const ed = editor as {
    view?: {
      state: {
        doc: {
          descendants: (cb: (node: PmNode, pos: number) => boolean | void) => void;
        };
        tr: {
          replaceWith: (from: number, to: number, content: unknown) => unknown;
        };
        schema: {
          nodes: {
            formulaBlock?: { create: (attrs: Record<string, unknown>) => PmNode };
          };
        };
      };
      dispatch: (tr: unknown) => void;
    };
  } | null;

  if (!ed?.view) return 0;
  const view = ed.view;
  const formulaBlockType = view.state.schema.nodes.formulaBlock;
  if (!formulaBlockType) return 0;

  // Build a lookup map by formulaId
  const dataMap = new Map<string, FormulaBlockData>();
  for (const d of blocksData) dataMap.set(d.formulaId, d);

  // Find all text markers in the document
  const MARKER_RE = /\[\[FORMULA:([^\]]+)\]\]/g;
  const markers: Array<{ pos: number; formulaId: string; nodeSize: number }> = [];
  view.state.doc.descendants((node: PmNode, pos: number) => {
    if (node.type.name === "paragraph") {
      try {
        const text = (node as unknown as { textContent?: string }).textContent || "";
        const match = text.match(/\[\[FORMULA:([^|]+)/);
        if (match) {
          const formulaId = match[1];
          markers.push({ pos, formulaId, nodeSize: node.nodeSize });
        }
      } catch { /* skip */ }
    }
  });

  if (markers.length === 0) return 0;

  // Also check for existing formulaBlock nodes (already restored)
  const existingIds = new Set<string>();
  view.state.doc.descendants((node: PmNode) => {
    if (node.type.name === "formulaBlock") {
      existingIds.add(node.attrs.formulaId as string);
    }
  });

  markers.reverse();
  let count = 0;
  for (const { pos, formulaId, nodeSize } of markers) {
    if (existingIds.has(formulaId)) continue; // Already restored
    const data = dataMap.get(formulaId);
    if (!data) continue;
    try {
      const formulaNode = formulaBlockType.create({
        formulaId: data.formulaId,
        latex: data.latex,
        value: data.value,
        display: data.display,
        showNumber: data.showNumber,
        equationNumber: data.equationNumber,
        showDescription: data.showDescription,
        descriptionText: data.descriptionText,
        cachedDataUrl: data.cachedDataUrl,
        cachedWidth: data.cachedWidth,
        cachedHeight: data.cachedHeight,
      });
      const tr = view.state.tr;
      tr.replaceWith(pos, pos + nodeSize, formulaNode);
      view.dispatch(tr);
      count++;
    } catch (e) {
      console.error("[restoreFormulaBlocksFromData] failed", e);
    }
  }

  console.log("[restoreFormulaBlocksFromData] restored", count, "blocks from saved data");
  return count;
}
