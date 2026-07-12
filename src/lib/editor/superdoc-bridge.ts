// ============================================================================
// SuperDocBridge — integration layer with @harbour-enterprises/superdoc.
//
// Mounts superdoc via string selectors (required by the engine), exposes
// lifecycle callbacks, and provides access to the Document API (editor.doc.*).
// Also exports utility helpers (renderCanvasPreview, resolveResourceValue)
// used by the AI executor and CanvasEditorDialog.
// ============================================================================

import type { AgentCommand, Block, CommandResult, DocumentMap } from "./types";
import { pmToBlocks, type PMJSON } from "./pmMap";

type SuperDocCtor = new (config: Record<string, unknown>) => SuperDocLike;
type SuperDocModule = { SuperDoc: SuperDocCtor; BlankDOCX: string };

interface SuperDocLike {
  activeEditor: EditorLike | null;
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
  export(params?: Record<string, unknown>): Promise<Blob>;
  destroy(): void;
  focus(): void;
  setZoom?(pct: number): void;
  toggleRuler?(): void;
  setShowBookmarks?(show: boolean): void;
  setShowFormattingMarks?(show: boolean): void;
  setDocumentMode?(mode: string): void;
  setLocked?(lock: boolean): void;
  search?(text: string | RegExp): unknown[] | undefined;
  goToSearchResult?(match: unknown): boolean | undefined;
  navigateTo?(target: unknown): Promise<boolean>;
  scrollToElement?(elementId: string): Promise<boolean>;
}

interface EditorLike {
  getJSON(): PMJSON;
  doc: unknown; // DocumentApi — accessed via unknown cast at call sites
  view: { state: { doc: PMNode; tr: { insert: (pos: number, c: unknown) => unknown; deleteRange: (a: number, b: number) => unknown } } };
  getHTML?(): string;
  focus?(): void;
}

export interface BridgeCallbacks {
  onReady?: (superdoc: SuperDocLike) => void;
  onUpdate?: (blocks: Block[]) => void;
  onPagination?: (totalPages: number) => void;
  onError?: (err: unknown) => void;
}

export interface BridgeUser {
  name: string;
  email: string;
  color: string;
}

export interface SuperDocBridge {
  mount(host: HTMLElement, toolbarHost: HTMLElement, file?: File | Blob | null, user?: BridgeUser, mode?: "edit" | "view"): Promise<void>;
  destroy(): void;
  setCallbacks(cb: BridgeCallbacks): void;
  getBlocks(): Block[];
  getDocumentMap(): DocumentMap;
  getActiveEditor(): EditorLike | null;
  getSuperdoc(): SuperDocLike | null;
  forceResync(): void;
  exportDocx(): Promise<Blob>;
  loadDocx(file: File | Blob, user?: BridgeUser): Promise<void>;
  setZoom(pct: number): void;
  setExternalResources(resources: DocumentMap["externalResources"]): void;
  getExternalResources(): DocumentMap["externalResources"];
  applyCommands(commands: AgentCommand[]): Promise<CommandResult[]>;
  /** Insert an interactive formula block (canvas NodeView, NOT an image). */
  insertFormulaBlock(opts: {
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
  }): boolean;
  /** Update formula blocks in the document when values are recalculated. */
  updateFormulaBlocks(formulaId: string, updates: Record<string, unknown>): void;
  /** Restore formulaBlock nodes from text markers (after loading a DOCX in edit mode). */
  restoreFormulaBlocksFromMarkers(): number;
  /** Render all formulaBlock nodes as images (for view mode). */
  renderFormulaBlocksAsImages(): Promise<number>;
  /** Get the editor JSON with formulaBlock nodes replaced by images (for view mode jsonOverride). */
  getViewJsonWithImages(): Promise<unknown | null>;
  /** Collect all formulaBlock data (including cached canvas) for .docs persistence. */
  collectFormulaBlockData(): unknown[];
  /** Restore formulaBlock nodes from saved data (includes cached canvas). */
  restoreFormulaBlocksFromData(data: unknown[]): number;
  /** Register the formula store so NodeViews can read it. */
  registerFormulaStore(store: unknown): void;
}

class SuperDocBridgeImpl implements SuperDocBridge {
  private host: HTMLElement | null = null;
  private toolbarHost: HTMLElement | null = null;
  private superdoc: SuperDocLike | null = null;
  private callbacks: BridgeCallbacks = {};
  private docMap: DocumentMap;
  private blocks: Block[] = [];
  private superDocCtor: SuperDocCtor | null = null;
  private blankDocxUrl: string | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Custom formula block extension (ProseMirror node with canvas NodeView). */
  private formulaBlockExtension: unknown = null;
  /** Helpers from formula-block-node.ts. */
  private formulaBlockHelpers: {
    registerFormulaStore: (id: string, store: unknown) => void;
    unregisterFormulaStore: (id: string) => void;
    setActiveEditorId: (id: string) => void;
    insertFormulaBlock: (editor: unknown, opts: Record<string, unknown>) => boolean;
    updateFormulaBlocks: (editor: unknown, formulaId: string, updates: Record<string, unknown>) => void;
  } | null = null;
  /** Reference to the formula-block-node module (loaded in loadModule). */
  private formulaBlockMod: typeof import("./formula-block-node") | null = null;

  constructor() {
    this.docMap = {
      meta: {
        id: `D-${Date.now().toString(36)}`,
        title: "Untitled Document",
        version: "1.0.0",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pageSize: { width: 794, height: 1123 },
        margin: 96,
      },
      styles: [],
      blocks: [],
      externalResources: [],
    };
  }

  setCallbacks(cb: BridgeCallbacks) {
    this.callbacks = cb;
  }
  getBlocks(): Block[] {
    return this.blocks;
  }
  getDocumentMap(): DocumentMap {
    return { ...this.docMap, blocks: this.blocks };
  }
  getActiveEditor(): EditorLike | null {
    return this.superdoc?.activeEditor ?? null;
  }
  getSuperdoc(): SuperDocLike | null {
    return this.superdoc;
  }
  setExternalResources(resources: DocumentMap["externalResources"]) {
    this.docMap = { ...this.docMap, externalResources: resources };
  }
  getExternalResources() {
    return this.docMap.externalResources;
  }

  private async loadModule(): Promise<void> {
    if (this.superDocCtor) return;
    const mod = (await import("@harbour-enterprises/superdoc")) as unknown as SuperDocModule;
    await import("@harbour-enterprises/superdoc/style.css");
    this.superDocCtor = mod.SuperDoc;
    this.blankDocxUrl = mod.BlankDOCX;
    try {
      const ext = await import("./formula-block-node");
      this.formulaBlockExtension = ext.formulaBlockNode;
      this.formulaBlockMod = ext;
      this.formulaBlockHelpers = {
        registerFormulaStore: ext.registerFormulaStore,
        unregisterFormulaStore: ext.unregisterFormulaStore,
        setActiveEditorId: ext.setActiveEditorId,
        insertFormulaBlock: ext.insertFormulaBlock,
        updateFormulaBlocks: ext.updateFormulaBlocks,
      };
    } catch (e) {
      console.warn("[superdoc-bridge] formula-block-node load failed, extension disabled:", e);
    }
  }

 async mount(host: HTMLElement, toolbarHost: HTMLElement, file?: File | Blob | null, user?: BridgeUser, mode: "edit" | "view" = "edit", jsonOverride?: unknown) {
    this.host = host;
    this.toolbarHost = toolbarHost;
    await this.loadModule();
    const Ctor = this.superDocCtor!;

    const uid = `sd-${Math.random().toString(36).slice(2, 9)}`;
    host.id = host.id || `superdoc-host-${uid}`;
    toolbarHost.id = toolbarHost.id || `superdoc-toolbar-${uid}`;

    const isViewMode = mode === "view";

    const config: Record<string, unknown> = {
      selector: `#${host.id}`,
      documentMode: isViewMode ? "viewing" : "editing",
      toolbar: `#${toolbarHost.id}`,
      isDev: false,
      disablePiniaDevtools: false,
      // Register custom extensions ONLY in edit mode (the paginated presentation-editor
      // in view mode doesn't support custom node views — formula blocks render as images).
      ...(!isViewMode && this.formulaBlockExtension ? { editorExtensions: [this.formulaBlockExtension] } : {}),
      viewOptions: { layout: isViewMode ? "print" : "web" },
      ...(isViewMode ? {
        rulers: true,
        useLayoutEngine: true,
        layoutEngineOptions: {
          flowMode: "paginated",
          // Don't force pageSize/margins — let the layout engine use the
          // document's native page size (Letter, A4, etc.) for accurate pagination.
          virtualization: { enabled: true, window: 6, overscan: 2 },
        },
      } : {}),
      // User identity — shown as comment author and used for track changes.
      user: user
        ? { name: user.name, email: user.email, color: user.color }
        : { name: "Пользователь", email: "user@docs.local", color: "#10b981" },
      modules: {
        toolbar: {
          selector: `#${toolbarHost.id}`,
          responsiveToContainer: true,
          showFormattingMarksButton: true,
          hideButtons: false,
        },
        comments: { visible: false, displayMode: "sidebar" },
      },
      // jsonOverride: when provided, the editor loads this JSON instead of
      // parsing the DOCX. Used for view mode (JSON has formula images instead
      // of formulaBlock nodes).
      ...(jsonOverride ? { jsonOverride } : {}),
    };

    if (file) {
      config.documents = [{
        id: `doc-${Date.now()}`,
        type: "docx",
        data: file as File,
        name: "document.docx",
      }];
    } else if (this.blankDocxUrl) {
      try {
        const resp = await fetch(this.blankDocxUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          const blankFile = new File([blob], "blank.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          });
          config.documents = [{
            id: `doc-${Date.now()}`,
            type: "docx",
            data: blankFile,
            name: "blank.docx",
          }];
        }
      } catch (e) {
        console.error("[bridge] blank DOCX fetch error:", e);
      }
    }

    this.superdoc = new Ctor(config);
    this.superdoc.on("ready", () => this.handleReady());
    this.superdoc.on("editor-update", () => this.scheduleResync());
    this.superdoc.on("pagination-update", (payload: unknown) => {
      const totalPages = (payload as { totalPages?: number })?.totalPages ?? 1;
      this.callbacks.onPagination?.(totalPages);
    });
    this.superdoc.on("content-error", (payload: unknown) => {
      console.error("[superdoc] content-error", payload);
      this.callbacks.onError?.(payload);
    });
    this.superdoc.on("exception", (payload: unknown) => {
      console.error("[superdoc] exception", payload);
      this.callbacks.onError?.(payload);
    });
  }

  private handleReady() {
    this.resyncBlocks();
    this.callbacks.onReady?.(this.superdoc!);
  }

  private scheduleResync() {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.resyncBlocks(), 120);
  }

  private resyncBlocks() {
    const editor = this.superdoc?.activeEditor;
    if (!editor) return;
    try {
      const json = editor.getJSON();
      this.blocks = pmToBlocks(json, this.blocks);
      this.docMap = { ...this.docMap, blocks: this.blocks, meta: { ...this.docMap.meta, updatedAt: new Date().toISOString() } };
      this.callbacks.onUpdate?.(this.blocks);
    } catch (e) {
      this.callbacks.onError?.(e);
    }
  }

  forceResync() {
    this.resyncBlocks();
  }

  /**
   * Get the editor's ProseMirror JSON with formulaBlock nodes replaced by
   * image nodes (rendered via renderFormula). Used for view mode: the JSON
   * is passed as jsonOverride when loading in view mode, so the layout
   * engine sees images from the start.
   */
  async getViewJsonWithImages(): Promise<unknown | null> {
    if (!this.superdoc) return null;
    const ed = (this.superdoc as { activeEditor?: { getJSON?: () => unknown } })?.activeEditor;
    if (!ed?.getJSON) return null;
    const json = ed.getJSON();
    // Walk the JSON and replace formulaBlock nodes with image nodes
    const { renderFormula } = await import("./formula-renderer");
    return this.replaceFormulaBlocksInJson(json, renderFormula);
  }

  /** Recursively walk ProseMirror JSON and replace formulaBlock nodes with images. */
  private async replaceFormulaBlocksInJson(json: unknown, renderFormula: typeof import("./formula-renderer")["renderFormula"]): Promise<unknown> {
    if (Array.isArray(json)) {
      const result: unknown[] = [];
      for (const item of json) {
        result.push(await this.replaceFormulaBlocksInJson(item, renderFormula));
      }
      return result;
    }
    if (json && typeof json === "object") {
      const obj = json as Record<string, unknown>;
      if (obj.type === "formulaBlock" && obj.attrs) {
        // Replace with an image node
        const attrs = obj.attrs as Record<string, unknown>;
        try {
          const { dataUrl, width, height } = await renderFormula({
            latex: attrs.latex as string,
            value: attrs.value as number | undefined,
            display: (attrs.display as "formula" | "value" | "both") || "both",
            showNumber: attrs.showNumber as boolean,
            equationNumber: attrs.equationNumber as number,
            showDescription: attrs.showDescription as boolean,
            descriptionText: attrs.descriptionText as string,
          });
          if (dataUrl) {
            return {
              type: "image",
              attrs: {
                src: dataUrl,
                alt: `[formula:${attrs.formulaId}]`,
                size: { width, height, unit: "px" },
              },
            };
          }
        } catch (e) {
          console.error("[replaceFormulaBlocksInJson] render failed", e);
        }
        // Fallback: keep the formulaBlock as a paragraph with marker text
        return {
          type: "paragraph",
          content: [{ type: "text", text: `[formula:${attrs.formulaId}]` }],
        };
      }
      // Recurse into content
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        result[key] = await this.replaceFormulaBlocksInJson(obj[key], renderFormula);
      }
      return result;
    }
    return json;
  }

  async exportDocx(): Promise<Blob> {
    if (!this.superdoc) throw new Error("superdoc not mounted");
    // Before exporting: replace formulaBlock nodes with text markers,
    // then restore them after export so the editor keeps working.
    const { replaceFormulaBlocksWithMarkers, restoreFormulaBlocksFromMarkers } = await import("./formula-block-node");
    const editor = (this.superdoc as { activeEditor?: unknown })?.activeEditor;
    let replaced = 0;
    if (editor) {
      replaced = replaceFormulaBlocksWithMarkers(editor);
      if (replaced > 0) await new Promise((r) => setTimeout(r, 1000));
    }
    try {
      const blob = await this.superdoc.export({ exportType: "docx", triggerDownload: false });
      return blob;
    } finally {
      // Restore formulaBlock nodes after export
      if (editor && replaced > 0) {
        restoreFormulaBlocksFromMarkers(editor);
      }
    }
  }

  /**
   * Export a view-mode DOCX with formula blocks rendered as images.
   * Replaces formulaBlock nodes with images (not markers), then exports.
   * Does NOT restore the original nodes (the document is left with images).
   * Use this to generate the view.docx for the .docs archive.
   */
  async exportViewDocx(): Promise<Blob> {
    if (!this.superdoc) throw new Error("superdoc not mounted");
    const { replaceFormulaBlocksWithImages } = await import("./formula-block-node");
    const editor = (this.superdoc as { activeEditor?: unknown })?.activeEditor;
    console.log("[exportViewDocx] editor:", !!editor);
    if (editor) {
      const count = await replaceFormulaBlocksWithImages(editor);
      console.log("[exportViewDocx] replaced", count, "blocks with images");
      // Wait for ProseMirror + Yjs to sync before exporting
      await new Promise((r) => setTimeout(r, 2000));
    }
    return this.superdoc.export({ exportType: "docx", triggerDownload: false });
  }

  async loadDocx(file: File | Blob | null, user?: BridgeUser, mode?: "edit" | "view", jsonOverride?: unknown) {
    if (!this.host || !this.toolbarHost) throw new Error("bridge not mounted");
    this.destroy();
    await this.mount(this.host, this.toolbarHost, file, user, mode, jsonOverride);
  }

  destroy() {
    try {
      this.superdoc?.destroy();
    } catch { /* ignore */ }
    this.superdoc = null;
    if (this.updateTimer) clearTimeout(this.updateTimer);
  }

  setZoom(pct: number) {
    this.superdoc?.setZoom?.(pct);
  }

  // AI command execution is handled by the store via Document API executor.
  async applyCommands(_commands: AgentCommand[]): Promise<CommandResult[]> {
    return [];
  }

  insertFormulaBlock(opts: {
    formulaId: string;
    latex: string;
    value?: number;
    display?: "formula" | "value" | "both";
    showNumber?: boolean;
    equationNumber?: number;
    showDescription?: boolean;
    descriptionText?: string;
  }): boolean {
    if (!this.superdoc?.activeEditor || !this.formulaBlockHelpers) {
      console.error("[bridge] cannot insert formula block — editor or helpers not ready");
      return false;
    }
    return this.formulaBlockHelpers.insertFormulaBlock(this.superdoc.activeEditor, opts);
  }

  updateFormulaBlocks(formulaId: string, updates: Record<string, unknown>): void {
    if (!this.superdoc?.activeEditor || !this.formulaBlockHelpers) return;
    this.formulaBlockHelpers.updateFormulaBlocks(this.superdoc.activeEditor, formulaId, updates);
  }

  restoreFormulaBlocksFromMarkers(): number {
    if (!this.superdoc?.activeEditor) return 0;
    if (!this.formulaBlockMod) return 0;
    try {
      return this.formulaBlockMod.restoreFormulaBlocksFromMarkers(this.superdoc.activeEditor);
    } catch (e) {
      console.warn("[restoreFormulaBlocksFromMarkers] failed", e);
      return 0;
    }
  }

  collectFormulaBlockData(): unknown[] {
    if (!this.superdoc?.activeEditor || !this.formulaBlockMod) return [];
    try {
      return this.formulaBlockMod.collectFormulaBlockData(this.superdoc.activeEditor);
    } catch (e) {
      console.warn("[collectFormulaBlockData] failed", e);
      return [];
    }
  }

  restoreFormulaBlocksFromData(data: unknown[]): number {
    if (!this.superdoc?.activeEditor || !this.formulaBlockMod) return 0;
    try {
      return this.formulaBlockMod.restoreFormulaBlocksFromData(
        this.superdoc.activeEditor,
        data as Array<Record<string, unknown>>,
      );
    } catch (e) {
      console.warn("[restoreFormulaBlocksFromData] failed", e);
      return 0;
    }
  }

  async renderFormulaBlocksAsImages(): Promise<number> {
    if (!this.superdoc?.activeEditor) return 0;
    try {
      const { replaceFormulaBlocksWithImages } = await import("./formula-block-node");
      return await replaceFormulaBlocksWithImages(this.superdoc.activeEditor);
    } catch (e) {
      console.warn("[renderFormulaBlocksAsImages] failed", e);
      return 0;
    }
  }

  registerFormulaStore(store: unknown): void {
    if (!this.formulaBlockHelpers) return;
    // Use a stable id for this bridge instance.
    const id = `bridge-${this.host?.id || "default"}`;
    this.formulaBlockHelpers.setActiveEditorId(id);
    this.formulaBlockHelpers.registerFormulaStore(id, store);
  }
}

/** Factory — creates a new bridge instance. */
export function createSuperDocBridge(): SuperDocBridge {
  return new SuperDocBridgeImpl();
}

// ============================================================================
// Utility helpers (kept for AI executor + CanvasEditorDialog)
// ============================================================================

/** Render a JS/TS canvas snippet to a PNG data URL using an offscreen canvas. */
export function renderCanvasPreview(code: string, _lang: "js" | "ts"): string {
  if (typeof document === "undefined") return "";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 320;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const jsCode = code
      .replace(/:\s*[A-Za-z_$][\w$<>[\]|&,\s]*/g, "")
      .replace(/(interface|type)\s+\w+[\s\S]*?\n}/g, "")
      .replace(/import\s+[^;]+;/g, "")
      .replace(/export\s+/g, "");
    const fn = new Function("canvas", "ctx", jsCode);
    fn(canvas, ctx);
    return canvas.toDataURL("image/png");
  } catch (e) {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 120;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#fee2e2";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#991b1b";
    ctx.font = "12px monospace";
    ctx.fillText(`canvas error: ${(e as Error).message}`.slice(0, 80), 8, 24);
    return canvas.toDataURL("image/png");
  }
}

/** Resolve a value from an external resource using a simple query. */
export function resolveResourceValue(
  res: { type: string; content: string; name: string },
  query?: string,
): string {
  if (!query) return res.content.slice(0, 200);
  if (res.type === "json") {
    try {
      const obj = JSON.parse(res.content);
      return String(queryPath(obj, query));
    } catch {
      return "[invalid json]";
    }
  }
  if (res.type === "xml") {
    try {
      const doc = new DOMParser().parseFromString(res.content, "application/xml");
      const node = doc.evaluate(query, doc, null, XPathResult.STRING_TYPE, null);
      return node.stringValue || "[not found]";
    } catch {
      return "[xml error]";
    }
  }
  if (res.type === "csv") {
    const lines = res.content.split(/\r?\n/);
    const [rowIdx, colIdx] = query.split(",").map((n) => parseInt(n, 10));
    return lines[rowIdx]?.split(",")[colIdx] ?? "[not found]";
  }
  return res.content.slice(0, 200);
}

function queryPath(obj: unknown, path: string): unknown {
  return path
    .replace(/^\$?\.?/, "")
    .split(".")
    .reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object") {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
}
