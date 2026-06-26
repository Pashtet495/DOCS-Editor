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
  mount(host: HTMLElement, toolbarHost: HTMLElement, file?: File | Blob | null, user?: BridgeUser): Promise<void>;
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
  }

 async mount(host: HTMLElement, toolbarHost: HTMLElement, file?: File | Blob | null, user?: BridgeUser) {
    this.host = host;
    this.toolbarHost = toolbarHost;
    await this.loadModule();
    const Ctor = this.superDocCtor!;

    const uid = `sd-${Math.random().toString(36).slice(2, 9)}`;
    host.id = host.id || `superdoc-host-${uid}`;
    toolbarHost.id = toolbarHost.id || `superdoc-toolbar-${uid}`;

    const config: Record<string, unknown> = {
      selector: `#${host.id}`,
      documentMode: "editing",
      toolbar: `#${toolbarHost.id}`,
      isDev: false,
      disablePiniaDevtools: false,
      viewOptions: { layout: "print" },
      layoutEngineOptions: {
        flowMode: "paginated",
        pageSize: { w: 794, h: 1123 },
        margins: { top: 96, right: 96, bottom: 96, left: 96, header: 48, footer: 48 },
        virtualization: { enabled: true, window: 6, overscan: 2 },
      },
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
    };

    if (file) {
      config.document = file as File;
    } else if (this.blankDocxUrl) {
      const blob = await fetch(this.blankDocxUrl).then((r) => r.blob());
      config.document = new File([blob], "blank.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
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

  async exportDocx(): Promise<Blob> {
    if (!this.superdoc) throw new Error("superdoc not mounted");
    return this.superdoc.export({ exportType: "docx", triggerDownload: false });
  }

  async loadDocx(file: File | Blob, user?: BridgeUser) {
    if (!this.host || !this.toolbarHost) throw new Error("bridge not mounted");
    this.destroy();
    await this.mount(this.host, this.toolbarHost, file, user);
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
