"use client";

import { create } from "zustand";
import type {
  AgentCommand,
  Block,
  ChatMessage,
  CommandResult,
  DocumentMap,
  FormulaEntry,
  FormulaStore,
  LlmSettings,
  ModelOption,
  RagHit,
} from "@/lib/editor/types";
import { DEFAULT_LLM } from "@/lib/editor/types";
import { emptyDocumentMap, type PMJSON } from "@/lib/editor/pmMap";
import { reindexBlocks, ragSearch } from "@/lib/ai/rag";
import { buildSystemPrompt, parseAgentCommands } from "@/lib/ai/system-prompt";
import { applyCommandsViaDocApi } from "@/lib/editor/doc-api-executor";
import { parseDocumentFormulas, createEmptyFormulaStore, recalculateFormulas, findFormulaMarkers, makeMarker } from "@/lib/editor/formula-parser";
import { scanAndRegisterFormulas } from "@/lib/editor/doc-formula-scanner";
import {
  createEmptyAutoFillStore,
  nextAutoFillFieldId,
  nextInstanceSuffix,
  makeAutoFillMarker,
  makeMarkerForInstance,
  getFieldInstances,
  getActiveSuffix,
  getInstanceValue,
  normalizeMappings,
  substituteAutoFillInJson,
  type AutoFillField,
  type AutoFillStore,
  type AutoFillSyncGroup,
} from "@/lib/editor/autofill-types";
import { substituteAutoFillInDocx } from "@/lib/editor/autofill-subst";
import type { TableDoc, Cell, CellLink, RightPanelBlock } from "@/lib/table/types";
import { toCellRef } from "@/lib/table/cell-utils";
import { evaluateTable } from "@/lib/table/formula-engine";
import {
  classifyFormula,
  getDependencies,
  isMatrixFormula,
  serializeMatrix,
} from "@/lib/table/calc-engine";
import { getMath } from "@/lib/editor/math-loader";
import type { SuperDocBridge } from "@/lib/editor/superdoc-bridge";

/** The bridge is the SuperDocBridge from superdoc-bridge.ts. */
type Bridge = SuperDocBridge;
/** The superdoc instance type — we use `unknown` and cast at call sites. */
type SuperDocInstance = unknown;

interface EditorStore {
  // superdoc instance + bridge
  superdoc: SuperDocInstance | null;
  setSuperdoc: (s: SuperDocInstance | null) => void;
  bridge: Bridge | null;
  setBridge: (b: Bridge | null) => void;

  // document state (projection of superdoc)
  blocks: Block[];
  docMap: DocumentMap;
  totalPages: number;
  ready: boolean;
  syncing: boolean;
  locked: boolean;
  /** Editor mode: "edit" = web layout (ProseMirror editable, custom nodes),
   *  "view" = print layout (paginated, headers/footers, formula blocks as images). */
  editorMode: "edit" | "view";
  /** Cached DOCX blobs for each mode. editDocBlob contains [[FORMULA:...]]
   *  text markers; viewDocBlob contains formula images. When switching modes,
   *  we load the appropriate blob instead of re-exporting. */
  editDocBlob: Blob | null;
  viewDocBlob: Blob | null;
  /** Saved formulaBlock data (including cached canvas dataUrls) — used to
   *  restore formula blocks after mode switching and .docs load. */
  formulaBlocksData: unknown[];
  /** PM positions of page breaks (from the layout engine in view mode).
   *  Used to draw accurate page break lines in edit mode. */
  pageBreakPositions: number[];
  /** Guard flag: true while the formula scanner is modifying the document
   *  (prevents infinite onBlocksUpdated → scan → modify → onBlocksUpdated loop). */
  parsingFormulas: boolean;

  // Auto-fill fields (document template system)
  autoFillStore: AutoFillStore;
  /** XML table editor dialog open state. */
  autoFillXmlEditorOpen: boolean;
  /** Sync mode — when true, user is setting up a sync group. Draft selections
   *  are stored in autoFillSyncDraft and do NOT affect the document until saved. */
  autoFillSyncMode: boolean;
  /** Draft field selections during sync setup: { fieldId: string[] }.
   *  Each field can have MULTIPLE draft values (for list sync 1:N).
   *  These are separate from field.selectedValue so the document is unaffected. */
  autoFillSyncDraft: Record<string, string[]>;

  // Table editor — spreadsheet documents stored as XML resources in .docs
  /** All table documents in the current project. */
  tableDocs: TableDoc[];
  /** ID of the table currently open in the editor dialog (null = closed). */
  tableEditorOpenId: string | null;
  /** Create a new empty table document and open it in the editor. */
  createTableDoc: (name?: string) => string;
  /** Open a table in the editor dialog. */
  openTableEditor: (id: string) => void;
  /** Close the table editor dialog. */
  closeTableEditor: () => void;
  /** Update a table document (replaces it entirely). */
  updateTableDoc: (id: string, patch: Partial<TableDoc>) => void;
  /** Delete a table document by id. */
  deleteTableDoc: (id: string) => void;
  /** Rename a table document (filesystem-safe name). */
  renameTableDoc: (id: string, name: string) => void;
  /** Replace the entire tableDocs array (used on .docs import). */
  setTableDocs: (docs: TableDoc[]) => void;
  /** Create a cell link: connects one or more table cells to ONE auto-fill field.
   *  Each cell gets a unique cellId (stored on Cell.linkId). All cellIds are
   *  collected into ONE CellLink record (cellIds: string[]). The AF field's
   *  `variants` array holds every cell value; its `selectedValue` is the first.
   *  A single RightPanelBlock (anchored to the first cell's row) is created. */
  createCellLink: (tableId: string, cells: Array<{ row: number; col: number }>, label: string, description: string) => string;
  /** Delete a cell link by ID: removes the link, clears the cell's linkId,
   *  removes the right-panel block, and deletes the AF field. */
  deleteCellLink: (tableId: string, linkId: string) => void;
  /** Update a right-panel block's offsetX (for drag-to-detach behavior). */
  updateRightPanelBlockOffset: (tableId: string, blockId: string, offsetX: number) => void;
  /** Sync auto-fill field values from linked table cells. Called after table edits. */
  syncCellLinksToAutoFill: (tableId: string) => void;

  // ── Formula link actions (table ↔ calculator integration) ─────────────
  /** Create a link between table cell(s) and a calculator FormulaEntry.
   *  - constant link (single cell): cell value ↔ FormulaEntry.value.
   *  - function link (single cell): FormulaEntry.value → cell.computed (read-only).
   *  - matrix link (range): cell range ↔ FormulaEntry.formula (matrix literal).
   *  Returns the new link ID, or "" on failure. */
  createFormulaLink: (
    tableId: string,
    cells: Array<{ row: number; col: number }>,
    formulaId: string,
    label: string,
    description: string,
  ) => string;
  /** Delete a formula link: clears cell styling + formulaLinkId, removes the
   *  CellLink record and its right-panel block. Does NOT delete the
   *  FormulaEntry (that persists in the calculator). */
  deleteFormulaLink: (tableId: string, linkId: string) => void;
  /** Sync table cell values → calculator FormulaStore for formula links.
   *  - constant links: cell value → FormulaEntry.value (+ formula = literal).
   *  - matrix links:   cell range → FormulaEntry.formula (matrix literal).
   *  - function links: skipped (value flows the other way).
   *  Then triggers recalcAndSyncFormulas() so dependent formulas update. */
  syncCellLinksToFormulas: (tableId: string) => void;
  /** Push calculator FormulaStore values → table cells for formula links.
   *  - function links: FormulaEntry.value → cell.computed (read-only).
   *  - constant links: FormulaEntry.value → cell.raw + computed (if the cell
   *    value differs — this is the reverse direction when the user edits the
   *    constant in the calculator UI).
   *  - matrix links: matrix literal → individual cell values in the range.
   *  Returns the updated cells array (caller writes it to the draft). */
  pushFormulaValuesToCells: (tableId: string) => (Cell | null)[][] | null;
  /** Toggle the "show formula LaTeX" flag on a right-panel block. */
  setRightPanelBlockShowLatex: (tableId: string, blockId: string, show: boolean) => void;
  /** Create a new FormulaEntry from the table editor (f+ button).
   *  - For constants/functions: name + formula + comment.
   *  - For matrix/vector: name + comment + a cell range (serialized into the
   *    formula field as a matrix literal, and the range gets a matrix link).
   *  Returns the new formula ID, or "" on failure. */
  createFormulaFromTable: (
    tableId: string,
    opts: {
      name: string;
      formula?: string;
      comment?: string;
      /** When set, creates a matrix/vector constant from this cell range
       *        instead of using `formula`. The range is serialized into a
       *        matrix literal and linked to the new FormulaEntry. */
      matrixCells?: Array<{ row: number; col: number }>;
    },
  ) => string;

  // AI agent
  chat: ChatMessage[];
  applying: boolean;
  lastResults: CommandResult[] | null;
  ragHits: RagHit[];
  /** Diff snapshot captured before AI applies commands (for reject/rollback). */
  preAiSnapshot: unknown | null;

  // LLM settings (chat + agent identity for comments/trackChanges)
  llm: LlmSettings;
  /** Current document user (shown as comment author). */
  user: { name: string; email: string; color: string };
  /** AI agent identity (used when AI adds comments). */
  agentUser: { name: string; email: string; color: string };
  models: ModelOption[];
  modelsLoading: boolean;
  modelsError: string | null;

  // UI
  activePanel: "agent" | "resources" | "settings";
  canvasEditor: { blockId: string | null; code: string; lang: "js" | "ts"; title: string } | null;
  /** LaTeX formula store — formulas, constants, history. Saved in .docs. */
  formulaStore: FormulaStore | null;
  /** Whether the formula/calculator panel is active. */
  calcModeActive: boolean;
  /** Formula insert dialog state — when open, shows preview + display options. */
  formulaInsertDialog: { formulaId: string; latex: string; value?: number } | null;
  /** Formula edit dialog state — edits an EXISTING formulaBlock in the document. */
  formulaEditDialog: { formulaId: string; blockPos?: number } | null;

  // actions
  onBlocksUpdated: (blocks: Block[]) => void;
  setTotalPages: (n: number) => void;
  setReady: (r: boolean) => void;
  /** Switch between "edit" (web layout, custom nodes) and "view" (paginated) modes. */
  setEditorMode: (mode: "edit" | "view") => void;
  /** Store page break PM positions (from the layout engine). */
  setPageBreakPositions: (positions: number[]) => void;
  setLocked: (l: boolean) => void;
  setLlm: (patch: Partial<LlmSettings>) => void;
  setUser: (patch: Partial<{ name: string; email: string; color: string }>) => void;
  setAgentUser: (patch: Partial<{ name: string; email: string; color: string }>) => void;
  /** Re-mount superdoc to apply a new user identity (required for comments). */
  applyUserAndRemount: () => Promise<void>;
  loadModels: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  applyCommands: (commands: AgentCommand[]) => Promise<CommandResult[]>;
  rejectCommands: () => void;
  /** Rollback to preAiSnapshot (undo AI changes). */
  rollbackAi: () => Promise<boolean>;
  setActivePanel: (p: "agent" | "resources" | "settings") => void;
  reindex: () => Promise<void>;
  openCanvasEditor: (blockId: string | null, code: string, lang: "js" | "ts", title: string) => void;
  closeCanvasEditor: () => void;
  /** Activate calculation mode and parse formulas from document. */
  activateCalcMode: () => void;
  /** Deactivate calculation mode. */
  deactivateCalcMode: () => void;
  /** Update the formula store (constants, history, etc.). */
  updateFormulaStore: (patch: Partial<FormulaStore>) => void;
  /** Insert a LaTeX formula at cursor position in the document. */
  insertFormulaAtCursor: (latexOrId: string) => void;
  /** Open formula insert dialog with preview. */
  openFormulaInsertDialog: (formulaId: string) => void;
  /** Close formula insert dialog. */
  closeFormulaInsertDialog: () => void;
  /** Open dialog to EDIT an existing formulaBlock (pencil button). */
  openFormulaEditDialog: (formulaId: string) => void;
  /** Close formula edit dialog. */
  closeFormulaEditDialog: () => void;
  /** Update an existing formulaBlock's display settings (from edit dialog). */
  updateExistingFormulaBlock: (opts: {
    formulaId: string;
    showDesignation?: boolean;
    showFormula?: boolean;
    showValue?: boolean;
    showNumber?: boolean;
    showDescription?: boolean;
    descriptionText?: string;
  }) => void;
  /** Insert formula as canvas-rendered image into document. */
  insertFormulaImage: (opts: {
    formulaId: string;
    showDesignation?: boolean;
    showFormula?: boolean;
    showValue?: boolean;
    showNumber?: boolean;
    showDescription?: boolean;
    descriptionText?: string;
    /** Manual equation number (overrides auto-numbering). */
    equationNumber?: number;
  }) => Promise<void>;
  /** Recalculate all formulas and sync values to document. */
  recalcAndSyncFormulas: () => void;
  /** Find {{F001}} markers in document and replace with computed values. */
  syncFormulaValues: () => void;
  /** Find $...$ in document and replace with {{F001}} markers. */
  replaceFormulasInDocument: () => void;

  // Auto-fill actions
  /** Create a new auto-fill field, optionally replacing text in the document. */
  createAutoFillField: (label: string, description: string, replaceText?: string, variants?: string[]) => string;
  /** Update an existing auto-fill field. */
  updateAutoFillField: (id: string, patch: Partial<AutoFillField>) => void;
  /** Delete an auto-fill field. */
  deleteAutoFillField: (id: string) => void;
  /** Add a variant to a field. */
  addAutoFillVariant: (fieldId: string, value: string) => void;
  /** Set the selected value for a field's ACTIVE instance. If applySync is true
   *  (default) and the value has sync mappings, linked fields' synced value
   *  LISTS are shown (the user picks one from the list). */
  setAutoFillValue: (fieldId: string, value: string, applySync?: boolean) => void;
  /** Set the selected value for a SPECIFIC instance (by suffix). */
  setAutoFillInstanceValue: (fieldId: string, suffix: string, value: string) => void;
  /** Create a new instance (duplicate) of a field — adds "_N" suffix.
   *  Returns the new suffix. Also inserts the marker into the document. */
  createAutoFillInstance: (fieldId: string) => string;
  /** Delete an instance (cannot delete the primary "" instance). */
  deleteAutoFillInstance: (fieldId: string, suffix: string) => void;
  /** Set the active instance suffix for a field (UI selector state). */
  setActiveAutoFillInstance: (fieldId: string, suffix: string) => void;
  /** Insert a specific instance marker into the document. */
  insertAutoFillInstanceMarker: (fieldId: string, suffix: string) => void;
  /** Enter sync setup mode — clears the draft. Cards show red until a draft
   *  value is picked. Document is NOT affected by draft selections. */
  startAutoFillSyncMode: () => void;
  /** Exit sync setup mode without saving (cancel). */
  cancelAutoFillSyncMode: () => void;
  /** Set a draft selection for a field during sync setup. In LIST sync mode,
   *  draft values accumulate (multi-select per field). */
  setAutoFillSyncDraftValue: (fieldId: string, value: string) => void;
  /** Clear draft selection for a field. */
  clearAutoFillSyncDraft: (fieldId: string) => void;
  /** Save sync mappings from draft selections. Creates/updates a sync group
   *  with LIST-based bidirectional mappings. Exits sync mode. */
  saveAutoFillSyncMappings: () => void;
  /** Delete a sync group and unlink its fields. */
  deleteAutoFillSyncGroup: (groupId: string) => void;
  /** Legacy toggle — kept for backwards compat. Calls start/cancel. */
  toggleAutoFillSyncMode: () => void;
  /** Create a sync group linking multiple fields (empty mappings). */
  createAutoFillSyncGroup: (fieldIds: string[]) => string;
  /** Open/close the XML table editor. */
  setAutoFillXmlEditorOpen: (open: boolean) => void;
  /** Set the variant filter (all/single/sync). */
  setAutoFillVariantFilter: (filter: "all" | "single" | "sync") => void;
  /** Replace AutoFillStore entirely (from XML editor or .docs import). */
  setAutoFillStore: (store: AutoFillStore) => void;
  /** Insert a field marker (primary instance) into the document at cursor. */
  insertAutoFillMarker: (fieldId: string) => void;

  updateResource: (id: string, patch: Partial<DocumentMap["externalResources"][number]>) => void;
  addResource: (r: Omit<DocumentMap["externalResources"][number], "id">) => void;
  removeResource: (id: string) => void;
  exportDocs: (downloadName?: string) => Promise<void>;
  /** Print the current document via Chromium print API (renders PDF). */
  printDocument: () => void;
  /** File name of the current .docs file (if saved). null = unsaved. */
  fileName: string | null;
  /** File handle for File System Access API (when available). */
  fileHandle: FileSystemFileHandle | null;
  /** Dirty flag — true when there are unsaved changes. */
  dirty: boolean;
  /** Recent documents list (from localStorage). */
  recentDocs: string[];
  /** Save current document as .docs file (download). */
  saveDocs: () => Promise<void>;
  /** Save as new .docs file (forces download dialog). */
  saveDocsAs: () => Promise<void>;
  /** Open a .docs file from File input. */
  openDocsFile: (file: File) => Promise<void>;
  /** Mark document as dirty (unsaved changes). */
  markDirty: () => void;
  /** Mark document as clean (saved). */
  markClean: () => void;
}

let msgId = 0;
const nextId = () => `m${++msgId}`;

/** Debounce timer for re-applying AutoFill substitution when a value changes
 *  while in view mode (triggers an edit→view round-trip to refresh the
 *  paginated document with the newly selected values). */
let autoFillViewRefreshTimer: ReturnType<typeof setTimeout> | null = null;

// ============================================================================
// localStorage persistence for settings
// ============================================================================
const STORAGE_KEYS = {
  llm: "docs-editor-llm",
  user: "docs-editor-user",
  agentUser: "docs-editor-agent-user",
};

function loadLlmSettings(): LlmSettings {
  if (typeof window === "undefined") return { ...DEFAULT_LLM };
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.llm);
    if (saved) return { ...DEFAULT_LLM, ...JSON.parse(saved) };
  } catch { /* ignore */ }
  return { ...DEFAULT_LLM };
}

function loadUserSettings(): { name: string; email: string; color: string } {
  if (typeof window === "undefined") return { name: "Пользователь", email: "user@docs.local", color: "#10b981" };
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.user);
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return { name: "Пользователь", email: "user@docs.local", color: "#10b981" };
}

function loadAgentUserSettings(): { name: string; email: string; color: string } {
  if (typeof window === "undefined") return { name: "AI Agent", email: "agent@docs.local", color: "#6366f1" };
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.agentUser);
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return { name: "AI Agent", email: "agent@docs.local", color: "#6366f1" };
}

function saveLlmSettings(llm: LlmSettings) {
  try {
    localStorage.setItem(STORAGE_KEYS.llm, JSON.stringify(llm));
  } catch { /* ignore */ }
}

function saveUserSettings(user: { name: string; email: string; color: string }) {
  try {
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
  } catch { /* ignore */ }
}

function saveAgentUserSettings(agent: { name: string; email: string; color: string }) {
  try {
    localStorage.setItem(STORAGE_KEYS.agentUser, JSON.stringify(agent));
  } catch { /* ignore */ }
}

function loadRecentDocs(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const saved = localStorage.getItem("docs-editor-recent");
    return saved ? JSON.parse(saved) : [];
  } catch { return []; }
}

function saveRecentDocs(docs: string[]) {
  try { localStorage.setItem("docs-editor-recent", JSON.stringify(docs.slice(0, 10))); } catch { /* ignore */ }
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  superdoc: null,
  setSuperdoc: (s) => set({ superdoc: s }),
  bridge: null,
  setBridge: (b) => set({ bridge: b }),

  blocks: [],
  docMap: emptyDocumentMap(),
  totalPages: 1,
  ready: false,
  syncing: false,
  locked: false,
  editorMode: "edit",
  editDocBlob: null,
  viewDocBlob: null,
  formulaBlocksData: [],
  pageBreakPositions: [],
  parsingFormulas: false,

  // Auto-fill
  autoFillStore: createEmptyAutoFillStore(),
  autoFillXmlEditorOpen: false,
  autoFillSyncMode: false,
  autoFillSyncDraft: {},

  // Table editor
  tableDocs: [],
  tableEditorOpenId: null,

  chat: [
    {
      id: nextId(),
      role: "assistant",
      content:
        "Здравствуйте! Я встроенный агент документа. Опишите, что нужно сделать — например, «исправь абзац про историю и добавь после него раздел про первое появление». Я сформирую команды для редактора.",
      ts: Date.now(),
    },
  ],
  applying: false,
  lastResults: null,
  ragHits: [],
  preAiSnapshot: null,

  llm: loadLlmSettings(),
  user: loadUserSettings(),
  agentUser: loadAgentUserSettings(),
  models: [],
  modelsLoading: false,
  modelsError: null,

  activePanel: "agent",
  canvasEditor: null,
  formulaStore: createEmptyFormulaStore(),
  calcModeActive: false,
  formulaInsertDialog: null,
  formulaEditDialog: null,

  fileName: null,
  fileHandle: null,
  dirty: false,
  recentDocs: loadRecentDocs(),

  onBlocksUpdated: (blocks) => {
    set((s) => {
      const prevBySig = new Map<string, Block>();
      for (const b of s.blocks) {
        const sig = b.id.split("-")[1];
        if (sig && b.embedding) prevBySig.set(sig, b);
      }
      const preserved = blocks.map((nb) => {
        const sig = nb.id.split("-")[1];
        if (sig) {
          const prev = prevBySig.get(sig);
          if (prev && prev.embedding && !nb.embedding) {
            return { ...nb, embedding: prev.embedding, embeddingModel: prev.embeddingModel };
          }
        }
        return nb;
      });
      return {
        blocks: preserved,
        dirty: s.ready ? true : s.dirty,
        docMap: { ...s.docMap, blocks: preserved, meta: { ...s.docMap.meta, updatedAt: new Date().toISOString() } },
      };
    });

    // ── Formula scanning pipeline ───────────────────────────────────────
    // Scan the document for LaTeX formulas ($...$, $$...$$, \(...\), \[...\]).
    // Found formulas are registered in the FormulaStore and the LaTeX text is
    // replaced with formulaBlock nodes in the document. A guard flag prevents
    // infinite loops (the replacement triggers another onBlocksUpdated).
    const { superdoc, formulaStore, parsingFormulas } = get();
    if (superdoc && !parsingFormulas && formulaStore) {
      const editor = (superdoc as { activeEditor?: unknown })?.activeEditor;
      if (editor) {
        try {
          const result = scanAndRegisterFormulas(editor, formulaStore);
          if (result && (result.foundCount > 0 || result.replacedCount > 0)) {
            set({ formulaStore: result.updatedStore, parsingFormulas: true });
            setTimeout(() => set({ parsingFormulas: false }), 1000);
          }
        } catch (e) {
          console.warn("[onBlocksUpdated] formula scan failed", e);
        }

        // Sync inDocument flags: scan the document for formulaBlock nodes
        // and update which formulas are actually in the document.
        try {
          const ed = (superdoc as {
            activeEditor?: {
              view?: {
                state: {
                  doc: {
                    descendants: (cb: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => boolean | void) => void;
                  };
                };
              };
            };
          })?.activeEditor;
          if (ed?.view) {
            const docFormulaIds = new Set<string>();
            ed.view.state.doc.descendants((node) => {
              if (node.type.name === "formulaBlock" && node.attrs.formulaId) {
                docFormulaIds.add(node.attrs.formulaId as string);
              }
            });
            // Update inDocument flags
            const currentStore = get().formulaStore;
            if (currentStore) {
              let changed = false;
              const updatedFormulas = currentStore.formulas.map((f) => {
                const shouldBe = docFormulaIds.has(f.id);
                if (f.inDocument !== shouldBe) {
                  changed = true;
                  return { ...f, inDocument: shouldBe, number: shouldBe ? f.number : undefined };
                }
                return f;
              });
              if (changed) {
                set({ formulaStore: { ...currentStore, formulas: updatedFormulas } });
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
  },

  setTotalPages: (n) => set({ totalPages: n }),
  setReady: (r) => set({ ready: r }),
  setPageBreakPositions: (positions) => set({ pageBreakPositions: positions }),
  setEditorMode: (mode) => {
    const { bridge, user, editorMode, editDocBlob, viewDocBlob } = get();
    if (editorMode === mode) return;
    set({ editorMode: mode, ready: false });
    if (!bridge) return;

    if (mode === "view") {
      // Switching TO view mode:
      // 1. Collect formulaBlock data (including cached canvas) BEFORE exporting
      // 2. Get the editor JSON with formulaBlock nodes replaced by images
      // 3. Apply AutoFill marker substitution to the JSON ({{AF###}} → selected values)
      // 4. Export the edit DOCX (with text markers) for caching
      // 5. Load the DOCX in view mode WITH the substituted image JSON as jsonOverride
      console.log("[setEditorMode] switching to view: collecting formula data...");
      const blocksData = bridge.collectFormulaBlockData();
      const afStore = get().autoFillStore;
      console.log("[setEditorMode] collected", blocksData.length, "formula blocks, getting view JSON...");
      Promise.all([
        bridge.getViewJsonWithImages(),
        bridge.exportDocx(),
      ]).then(async ([viewJson, editBlob]) => {
        // Apply AutoFill marker substitution to the view JSON so the
        // paginated view shows selected values instead of {{AF###}} markers.
        const substitutedJson = viewJson ? substituteAutoFillInJson(viewJson, afStore) : viewJson;
        const substCount = afStore.fields.filter((f) => f.selectedValue).length;
        console.log(`[setEditorMode] view JSON ready (${substCount} autofill values substituted), loading in view mode...`);
        set({ editDocBlob: editBlob, formulaBlocksData: blocksData });
        const file = new File([editBlob], "edit.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        bridge.loadDocx(file, user, "view", substitutedJson || undefined).catch((e) => {
          console.error("[setEditorMode] view load failed", e);
          set({ ready: true });
        });
      }).catch((e) => {
        console.error("[setEditorMode] view export failed", e);
        set({ ready: true });
      });
    } else {
      // Switching TO edit mode:
      // Load the cached editDocBlob (contains text markers) and restore
      // formulaBlock nodes from saved data (includes cached canvas).
      const blocksData = get().formulaBlocksData;
      if (editDocBlob) {
        const file = new File([editDocBlob], "edit.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        bridge.loadDocx(file, user, "edit").then(() => {
          // Restore formulaBlock nodes — wait for SuperDoc to be ready,
          // then restore. Uses polling with increasing delay (max 5 attempts).
          const tryRestore = (attempt: number) => {
            const ed = (bridge as unknown as { getActiveEditor?: () => { getJSON?: () => unknown } | null })?.getActiveEditor?.();
            if (ed) {
              // Editor is ready — restore formulas
              if (blocksData.length > 0) {
                const count = bridge.restoreFormulaBlocksFromData(blocksData);
                if (count > 0) {
                  console.log("[setEditorMode] restored", count, "formula blocks from saved data");
                  return;
                }
              }
              // Fallback: restore from markers (no cached canvas)
              const count = bridge.restoreFormulaBlocksFromMarkers();
              if (count > 0) {
                console.log("[setEditorMode] restored", count, "formula blocks from markers");
                return;
              }
              // If restore returned 0, the editor may not be fully ready yet
              if (attempt < 5) {
                console.log(`[setEditorMode] restore returned 0, retry ${attempt + 1}/5`);
                setTimeout(() => tryRestore(attempt + 1), 300 + attempt * 200);
              } else {
                console.warn("[setEditorMode] formula restore failed after 5 attempts");
              }
            } else if (attempt < 5) {
              // Editor not ready yet — retry
              setTimeout(() => tryRestore(attempt + 1), 300 + attempt * 200);
            } else {
              console.warn("[setEditorMode] editor never became ready for formula restore");
            }
          };
          // Start first attempt after a short delay to let ProseMirror initialize
          setTimeout(() => tryRestore(0), 200);
        }).catch((e) => {
          console.error("[setEditorMode] edit load failed", e);
          set({ ready: true });
        });
      } else {
        console.warn("[setEditorMode] no cached editDocBlob, loading blank");
        bridge.loadDocx(null, user, "edit").catch((e) => {
          console.error("[setEditorMode] blank load failed", e);
          set({ ready: true });
        });
      }
    }
  },
  setLocked: (l) => {
    const { superdoc } = get();
    // superdoc.setLocked() requires ydoc (collaboration) which is not available
    // in standalone mode. Use editor.setEditable() instead — it directly
    // toggles editability on the ProseMirror view.
    const sd = superdoc as {
      activeEditor?: { setEditable?: (editable: boolean, emitUpdate?: boolean) => void };
      lockSuperdoc?: (isLocked: boolean, lockedBy: unknown) => void;
    } | null;
    try {
      sd?.activeEditor?.setEditable?.(!l, true);
      sd?.lockSuperdoc?.(l, null);
    } catch (e) {
      console.warn("[setLocked] failed", e);
    }
    set({ locked: l });
  },

  setLlm: (patch) => set((s) => {
    const llm = { ...s.llm, ...patch };
    saveLlmSettings(llm);
    return { llm };
  }),

  setUser: (patch) => set((s) => {
    const user = { ...s.user, ...patch };
    saveUserSettings(user);
    return { user };
  }),
  setAgentUser: (patch) => set((s) => {
    const agentUser = { ...s.agentUser, ...patch };
    saveAgentUserSettings(agentUser);
    return { agentUser };
  }),

  applyUserAndRemount: async () => {
    const { bridge, user } = get();
    if (!bridge) return;
    // Export current doc, then re-mount with new user identity.
    try {
      const blob = await bridge.exportDocx();
      const file = new File([blob], "current.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      await bridge.loadDocx(file, user);
    } catch (e) {
      console.error("[applyUserAndRemount] failed", e);
    }
  },

  loadModels: async () => {
    const { llm } = get();
    set({ modelsLoading: true, modelsError: null });
    try {
      const { llmModels } = await import("@/lib/llm/llm-client");
      const { models, error } = await llmModels({ baseUrl: llm.baseUrl, apiKey: llm.apiKey });
      set({ models, modelsLoading: false, modelsError: error || null });
      if (models.length) {
        const chat = models.find((m: ModelOption) => /embed/i.test(m.id)) ? models.find((m: ModelOption) => !/embed/i.test(m.id)) : models[0];
        const embed = models.find((m: ModelOption) => /embed/i.test(m.id)) || models[0];
        const { llm: currentLlm } = get();
        get().setLlm({
          chatModel: currentLlm.chatModel || (chat as ModelOption)?.id || "",
          embeddingModel: currentLlm.embeddingModel || (embed as ModelOption)?.id || "",
        });
      }
    } catch (e) {
      set({ modelsLoading: false, modelsError: (e as Error).message });
    }
  },

  sendMessage: async (text) => {
    const { llm, blocks, docMap, superdoc, chat } = get();
    if (!llm.chatModel) {
      set({
        chat: [
          ...chat,
          { id: nextId(), role: "assistant", content: "⚠️ Сначала выберите чат-модель в панели «Настройки».", ts: Date.now() },
        ],
      });
      return;
    }
    const userMsg: ChatMessage = { id: nextId(), role: "user", content: text, ts: Date.now() };
    set({ chat: [...chat, userMsg], applying: true, ragHits: [] });

    // RAG is now ON-DEMAND only — not run on every message.
    // The agent can request RAG via the "RAG" button, or it runs automatically
    // only for large documents (50+ blocks) where the block index alone is too big.
    let ragHits: RagHit[] = [];
    const shouldAutoRag = llm.embeddingModel && blocks.length >= 50;
    if (shouldAutoRag) {
      console.log("[agent] auto-RAG enabled (document has", blocks.length, "blocks)");
      const r = await ragSearch(llm.baseUrl, llm.apiKey, llm.embeddingModel, blocks, text, 6, 0.2, llm.matryoshkaDim || 0);
      ragHits = r.hits;
      set({ ragHits });
    } else {
      set({ ragHits: [] });
    }

    // Build system prompt + call LLM.
    const system = buildSystemPrompt({ doc: { ...docMap, blocks }, ragHits, blocks });
    const messages = [
      { role: "system", content: system },
      ...chat.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ];

    try {
      const { llmChat } = await import("@/lib/llm/llm-client");
      const { content, error } = await llmChat({
        baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.chatModel,
        messages, temperature: 0.2,
      });
      console.log("[agent] LLM response:", { length: content.length, first200: content.slice(0, 200), error });
      if (error) {
        set({
          chat: [
            ...get().chat,
            { id: nextId(), role: "assistant", content: `⚠️ Ошибка LLM: ${error}`, ts: Date.now() },
          ],
          applying: false,
        });
        return;
      }
      const { commands } = parseAgentCommands(content);
      console.log("[agent] parsed commands:", commands.length, commands.length ? commands[0] : null);
      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: "assistant",
        content: commands.length
          ? `Сформировал ${commands.length} команд(ы). Просмотрите и нажмите «Применить».\n\n\`\`\`json\n${JSON.stringify(commands, null, 2)}\n\`\`\``
          : content || "(пустой ответ модели)",
        commands: commands.length ? commands : undefined,
        ts: Date.now(),
      };
      set({ chat: [...get().chat, assistantMsg], applying: false });
      if (!commands.length || !superdoc) return;
    } catch (e) {
      set({
        chat: [
          ...get().chat,
          { id: nextId(), role: "assistant", content: `⚠️ ${(e as Error).message}`, ts: Date.now() },
        ],
        applying: false,
      });
    }
  },

  applyCommands: async (commands) => {
    const { superdoc, bridge } = get();
    if (!superdoc) return [];
    const editor = (superdoc as { activeEditor: { getJSON(): PMJSON; doc: unknown } } | null)?.activeEditor;
    if (!editor) return [];
    set({ applying: true });

    // 1. Capture diff snapshot BEFORE applying (for rollback).
    let snapshot: unknown = null;
    try {
      snapshot = (editor as unknown as { doc: { diff: { capture: () => unknown } } }).doc.diff.capture();
    } catch (e) {
      console.warn("[diff] capture failed", e);
    }
    set({ preAiSnapshot: snapshot });

    // 2. Lock the document during AI generation to prevent user conflicts.
    get().setLocked(true);

    // 3. Apply commands via Document API (editor.doc.*).
    const { results, updatedResources } = await applyCommandsViaDocApi(editor, commands, get().docMap, get().agentUser);

    // 4. Unlock.
    get().setLocked(false);

    set({ applying: false, lastResults: results });

    // 5. Refresh block projection + resources (canvas inserts create resources).
    try {
      const json = (editor as { getJSON(): PMJSON }).getJSON();
      const { pmToBlocks } = await import("@/lib/editor/pmMap");
      const blocks = pmToBlocks(json, get().blocks);
      // Update bridge resources + store from executor result.
      bridge?.setExternalResources(updatedResources);
      set({ blocks, docMap: { ...get().docMap, blocks, externalResources: updatedResources } });
    } catch (e) {
      console.error("[applyCommands] resync failed", e);
    }

    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    set({
      chat: [
        ...get().chat,
        {
          id: nextId(),
          role: "assistant",
          content: `✅ Применено ${ok} команд${fail ? `, ${fail} с ошибкой` : ""}.\n${results.map((r) => `${r.ok ? "✓" : "✗"} ${r.command.cmd}${r.affectedBlockId ? " " + r.affectedBlockId : ""} — ${r.message}`).join("\n")}\n\nСнимок изменений сохранён. Можно откатить кнопкой «Отменить AI».`,
          ts: Date.now(),
        },
      ],
    });
    return results;
  },

  rejectCommands: () => {
    set((s) => {
      const last = s.chat[s.chat.length - 1];
      if (last?.commands) {
        last.commands = undefined;
        last.content = "Команды отклонены пользователем.\n\n" + last.content;
      }
      return { chat: [...s.chat] };
    });
  },

  rollbackAi: async () => {
    const { superdoc, preAiSnapshot } = get();
    if (!superdoc || !preAiSnapshot) return false;
    const editor = (superdoc as { activeEditor: { getJSON(): PMJSON; doc: unknown } } | null)?.activeEditor;
    if (!editor) return false;
    try {
      // Use history.undo to roll back the AI-applied transactions.
      // The Document API diff.apply could also restore, but undo is simpler
      // for a single rollback step.
      (editor as unknown as { doc: { history: { undo: () => unknown } } }).doc.history.undo();
      set({ preAiSnapshot: null });
      // Refresh blocks.
      const json = editor.getJSON() as PMJSON;
      const { pmToBlocks } = await import("@/lib/editor/pmMap");
      const blocks = pmToBlocks(json, get().blocks);
      set({ blocks, docMap: { ...get().docMap, blocks } });
      set({
        chat: [
          ...get().chat,
          { id: nextId(), role: "assistant", content: "↩️ Изменения AI откатаны.", ts: Date.now() },
        ],
      });
      return true;
    } catch (e) {
      console.error("[rollback] failed", e);
      return false;
    }
  },

  setActivePanel: (p) => set({ activePanel: p }),

  reindex: async () => {
    const { llm, blocks } = get();
    if (!llm.embeddingModel) return;
    set({ syncing: true });
    const r = await reindexBlocks(llm.baseUrl, llm.apiKey, llm.embeddingModel, blocks, 16, llm.matryoshkaDim || 0);
    if (r.blocks) {
      set({ blocks: r.blocks, docMap: { ...get().docMap, blocks: r.blocks } });
    }
    set({ syncing: false });
  },

  openCanvasEditor: (blockId, code, lang, title) =>
    set({ canvasEditor: { blockId, code, lang, title } }),
  closeCanvasEditor: () => set({ canvasEditor: null }),

  activateCalcMode: () => {
    const { blocks, formulaStore } = get();
    const existing = formulaStore?.formulas || [];
    // Parse: find $...$ AND existing {{F001:...}} markers.
    const parsedFormulas = parseDocumentFormulas(blocks, existing);
    const recalced = recalculateFormulas(parsedFormulas);

    if (formulaStore) {
      set({ calcModeActive: true, formulaStore: { ...formulaStore, formulas: recalced } });
    } else {
      const store = createEmptyFormulaStore();
      store.formulas = [...store.formulas, ...recalced.filter(f => !store.formulas.some(s => s.name === f.name))];
      set({ calcModeActive: true, formulaStore: store });
    }
    // Replace $...$ with {{F001:value}} markers.
    get().replaceFormulasInDocument();
  },
  deactivateCalcMode: () => set({ calcModeActive: false }),
  updateFormulaStore: (patch) => {
    const oldStore = get().formulaStore;
    if (!oldStore) return;

    // Check if formula entries (name, formula, comment) changed — if so,
    // update formulaBlock nodes in the document directly (not just recalc values).
    // We do this BEFORE calling recalcAndSyncFormulas to avoid a double set().
    if (patch.formulas) {
      const { bridge, editorMode } = get();
      if (bridge && editorMode === "edit") {
        for (let i = 0; i < patch.formulas.length; i++) {
          const newF = patch.formulas[i];
          const oldF = oldStore.formulas.find((f) => f.id === newF.id);
          if (oldF && (oldF.name !== newF.name || oldF.formula !== newF.formula || oldF.comment !== newF.comment)) {
            // This formula's metadata changed — update its formulaBlock nodes
            bridge.updateFormulaBlocks(newF.id, {
              designation: newF.name,
              latex: newF.formula,
              cachedDataUrl: "", // Clear cache to force re-render
              cachedWidth: 0,
              cachedHeight: 0,
            });
          }
        }
      }
    }

    // Recalculate values from the patched formulas, then set ONCE.
    // recalcAndSyncFormulas reads from the store, so we apply the patch first
    // in a local variable, recalc, then set the final result in one call.
    const patchedStore = { ...oldStore, ...patch };
    const recalced = recalculateFormulas(patchedStore.formulas);

    // Detect if any values changed after recalc.
    let valuesChanged = recalced.length !== oldStore.formulas.length;
    if (!valuesChanged) {
      for (let i = 0; i < recalced.length; i++) {
        if (!oldStore.formulas[i] ||
            recalced[i].value !== oldStore.formulas[i].value ||
            recalced[i].name !== oldStore.formulas[i].name ||
            recalced[i].formula !== oldStore.formulas[i].formula ||
            recalced[i].comment !== oldStore.formulas[i].comment) {
          valuesChanged = true;
          break;
        }
      }
    }

    // Determine if non-formula fields (history, settings) changed.
    const nonFormulaChanged = Object.keys(patch).some((k) => k !== "formulas");

    // Only set if something actually changed. This avoids creating a new
    // formulaStore reference on every call (which would re-trigger all
    // subscribers, including the table editor's useEffect([formulaStore])).
    if (valuesChanged || nonFormulaChanged) {
      set({ formulaStore: { ...patchedStore, formulas: recalced } });

      // Update formulaBlock nodes for changed values (only in edit mode).
      const { bridge, editorMode } = get();
      if (bridge && editorMode === "edit") {
        for (let i = 0; i < recalced.length; i++) {
          const oldF = oldStore.formulas.find((f) => f.id === recalced[i].id);
          if (oldF && oldF.value !== recalced[i].value) {
            bridge.updateFormulaBlocks(recalced[i].id, {
              designation: recalced[i].name,
              latex: recalced[i].formula,
              value: recalced[i].value,
              cachedDataUrl: "",
              cachedWidth: 0,
              cachedHeight: 0,
            });
          }
        }
      }
    }

    // Sync {{F001:old}} → {{F001:new}} markers in the document.
    get().syncFormulaValues();
  },
  insertFormulaAtCursor: (latexOrId) => {
    const { superdoc, formulaStore } = get();
    if (!superdoc || !formulaStore) return;

    let formula: FormulaEntry | undefined;

    if (latexOrId.startsWith("F") && formulaStore.formulas.some(f => f.id === latexOrId)) {
      // Insert existing formula by ID — use {{F001:value}} marker.
      formula = formulaStore.formulas.find(f => f.id === latexOrId);
    } else {
      // New formula from expression — create entry.
      const maxFNum = formulaStore.formulas
        .filter(f => f.id.startsWith("F") && /^F\d+$/.test(f.id))
        .reduce((max, f) => Math.max(max, parseInt(f.id.slice(1), 10)), 0);
      const newId = `F${String(maxFNum + 1).padStart(3, "0")}`;
      const nameMatch = latexOrId.match(/^\\?([a-zA-Z][a-zA-Z0-9_]*)\s*=/);
      const name = nameMatch ? nameMatch[1] : `f${formulaStore.formulas.length + 1}`;
      formula = { id: newId, name, formula: latexOrId, latex: latexOrId, userCreated: true, inDocument: true };
      const allFormulas = recalculateFormulas([...formulaStore.formulas, formula]);
      set({ formulaStore: { ...formulaStore, formulas: allFormulas } });
      formula = allFormulas.find(f => f.id === newId);
    }

    if (!formula) return;
    // Insert {{F001:value}} marker — preserves ID for recalculation.
    const marker = makeMarker(formula);
    try {
      const ed = (superdoc as { activeEditor?: { doc: { insert: (input: { value: string; type?: string }) => unknown } } })?.activeEditor;
      ed?.doc.insert({ value: marker, type: "text" });
      // Mark formula as inDocument.
      set((s) => ({
        formulaStore: s.formulaStore ? {
          ...s.formulaStore,
          formulas: s.formulaStore.formulas.map(f => f.id === formula!.id ? { ...f, inDocument: true } : f),
        } : null,
      }));
    } catch (e) { console.error("[insertFormula] failed:", e); }
  },
  openFormulaInsertDialog: (formulaId) => {
    const { formulaStore } = get();
    if (!formulaStore) return;
    const formula = formulaStore.formulas.find(f => f.id === formulaId);
    if (!formula) {
      console.warn("[openFormulaInsertDialog] formula not found:", formulaId);
      return;
    }
    console.log("[formula] opening insert dialog for", formulaId, formula.name, "value:", formula.value);
    set({ formulaInsertDialog: { formulaId, latex: formula.formula, value: formula.value } });
  },
  closeFormulaInsertDialog: () => set({ formulaInsertDialog: null }),
  openFormulaEditDialog: (formulaId) => {
    set({ formulaEditDialog: { formulaId } });
  },
  closeFormulaEditDialog: () => set({ formulaEditDialog: null }),
  updateExistingFormulaBlock: (opts) => {
    const { bridge } = get();
    if (!bridge) return;
    bridge.updateFormulaBlocks(opts.formulaId, {
      showDesignation: opts.showDesignation,
      showFormula: opts.showFormula,
      showValue: opts.showValue,
      showNumber: opts.showNumber,
      showDescription: opts.showDescription,
      descriptionText: opts.descriptionText || "",
      cachedDataUrl: "",
      cachedWidth: 0,
      cachedHeight: 0,
    });
    set({ formulaEditDialog: null });
  },
  insertFormulaImage: async (opts) => {
    const { superdoc, formulaStore, editorMode } = get();
    if (!superdoc || !formulaStore) return;

    const formula = formulaStore.formulas.find(f => f.id === opts.formulaId);
    if (!formula) { console.error("[insertFormulaImage] formula not found:", opts.formulaId); return; }

    // Determine equation number — manual override or auto
    const autoNumber = formulaStore.formulas.filter(f => f.inDocument).length + 1;
    const equationNumber = opts.equationNumber || autoNumber;

    console.log("[insertFormulaBlock] formula:", formula.id, formula.name, "mode:", editorMode, "number:", equationNumber);

    // In VIEW mode (paginated), insert as a static image.
    // In EDIT mode (web layout), insert as an interactive canvas block.
    if (editorMode === "view") {
      try {
        const { renderFormula } = await import("@/lib/editor/formula-renderer");
        const { dataUrl, width, height } = await renderFormula({
          latex: formula.formula,
          designation: formula.name,
          value: formula.value,
          showDesignation: opts.showDesignation,
          showFormula: opts.showFormula,
          showValue: opts.showValue,
          showNumber: opts.showNumber,
          equationNumber,
          showDescription: opts.showDescription,
          descriptionText: opts.descriptionText,
          formulaStore,
          formula,
        });
        if (!dataUrl) { console.error("[insertFormulaImage] render failed"); set({ formulaInsertDialog: null }); return; }

        const ed = (superdoc as { activeEditor?: { doc: { create: { image: (input: { at?: { kind: string }; src: string; alt?: string; size?: { width: number; height: number; unit?: string } }) => { success: boolean; failure?: { message?: string } } } } } })?.activeEditor;
        if (!ed?.doc?.create?.image) { console.error("[insertFormulaImage] no editor.doc.create.image"); set({ formulaInsertDialog: null }); return; }
        const r = ed.doc.create.image({
          at: { kind: "documentEnd" },
          src: dataUrl,
          alt: `[formula:${formula.id}] ${formula.name}`,
          size: { width, height, unit: "px" },
        });
        if (r.success) {
          set((s) => ({
            formulaStore: s.formulaStore ? {
              ...s.formulaStore,
              formulas: s.formulaStore.formulas.map(f => f.id === opts.formulaId ? { ...f, inDocument: true, number: equationNumber } : f),
            } : s.formulaStore,
          }));
          console.log("[insertFormulaImage] inserted as image (view mode)");
        }
      } catch (e) { console.error("[insertFormulaImage] view mode error:", e); }
      set({ formulaInsertDialog: null });
      return;
    }

    // EDIT mode — insert interactive canvas block.
    try {
      const { bridge } = get();
      const ok = bridge?.insertFormulaBlock({
        formulaId: formula.id,
        latex: formula.formula,
        designation: formula.name,
        value: formula.value,
        showDesignation: opts.showDesignation,
        showFormula: opts.showFormula,
        showValue: opts.showValue,
        showNumber: opts.showNumber,
        equationNumber,
        showDescription: opts.showDescription,
        descriptionText: opts.descriptionText || "",
      });

      if (ok) {
        // Mark formula as inDocument + save the equation number.
        set((s) => ({
          formulaStore: s.formulaStore ? {
            ...s.formulaStore,
            formulas: s.formulaStore.formulas.map(f => f.id === opts.formulaId ? { ...f, inDocument: true, number: equationNumber } : f),
          } : s.formulaStore,
        }));
        console.log("[insertFormulaBlock] inserted interactive block successfully");
      } else {
        console.error("[insertFormulaBlock] bridge.insertFormulaBlock returned false");
      }
    } catch (e) {
      console.error("[insertFormulaBlock] error:", e);
    }

    set({ formulaInsertDialog: null });
  },
  recalcAndSyncFormulas: () => {
    const { formulaStore, bridge, editorMode } = get();
    if (!formulaStore) return;
    const oldFormulas = formulaStore.formulas;
    const recalced = recalculateFormulas(formulaStore.formulas);

    // Find which formulas changed (value, name, formula, comment)
    const changedIds = new Set<string>();
    for (let i = 0; i < recalced.length; i++) {
      if (!oldFormulas[i]) continue;
      if (recalced[i].value !== oldFormulas[i].value ||
          recalced[i].name !== oldFormulas[i].name ||
          recalced[i].formula !== oldFormulas[i].formula ||
          recalced[i].comment !== oldFormulas[i].comment) {
        changedIds.add(recalced[i].id);
      }
    }

    // Only update the store if something actually changed. This prevents
    // cascading re-renders: recalculateFormulas always returns new object
    // references, so an unconditional set() would give formulaStore a new
    // reference on every call and re-trigger all subscribers (including the
    // table editor's useEffect([formulaStore]) → pushFormulaValuesToCells).
    if (changedIds.size > 0) {
      set({ formulaStore: { ...formulaStore, formulas: recalced } });
    }

    // Update formulaBlock nodes in the document for changed formulas
    if (changedIds.size > 0 && bridge && editorMode === "edit") {
      for (const formulaId of changedIds) {
        const formula = recalced.find((f) => f.id === formulaId);
        if (formula) {
          // Update ALL parameters + clear cache to force re-render
          bridge.updateFormulaBlocks(formulaId, {
            designation: formula.name,
            latex: formula.formula,
            value: formula.value,
            cachedDataUrl: "",
            cachedWidth: 0,
            cachedHeight: 0,
          });
        }
      }
      console.log("[recalc] updated", changedIds.size, "formula blocks");
    }

    get().syncFormulaValues();
  },
  syncFormulaValues: () => {
    // Update {{F001:old_value}} → {{F001:new_value}} in document.
    // The marker {{F001:...}} is PRESERVED — only the value part changes.
    const { superdoc, formulaStore, blocks } = get();
    if (!superdoc || !formulaStore) return;

    const markers = findFormulaMarkers(blocks);
    if (markers.length === 0) return;

    console.log("[syncFormulas] found", markers.length, "markers");

    try {
      const ed = (superdoc as { activeEditor?: { doc: { find: (input: { select: { type: string; pattern: string } }) => { total: number; items: Array<{ address: { blockId?: string; nodeId?: string; nodeType?: string } }> }; replace: (input: { target: unknown; content: unknown }) => { success?: boolean } } } })?.activeEditor;
      if (!ed?.doc) return;

      for (const marker of markers) {
        const formula = formulaStore.formulas.find(f => f.id === marker.formulaId);
        if (!formula) continue;

        // Build old and new marker strings.
        const oldMarker = marker.currentValue !== null
          ? `{{${marker.formulaId}:${marker.currentValue}}}`
          : `{{${marker.formulaId}}}`;
        const newMarker = makeMarker(formula);

        if (oldMarker === newMarker) continue; // No change needed.

        // Find the old marker text in the document.
        const findResult = ed.doc.find({ select: { type: "text", pattern: oldMarker } });
        if (findResult.total > 0 && findResult.items[0]) {
          const target = findResult.items[0].address;
          const blockId = target.blockId || target.nodeId;
          if (blockId) {
            // Replace with new marker (same ID, updated value).
            ed.doc.replace({
              target: { kind: "block", nodeType: target.nodeType || "paragraph", nodeId: blockId },
              content: { kind: "paragraph", paragraph: { inlines: [{ kind: "run", run: { text: newMarker } }] } },
            });
            console.log("[syncFormulas]", oldMarker, "→", newMarker);
          }
        }
      }
    } catch (e) {
      console.error("[syncFormulas] failed:", e);
    }
  },
  replaceFormulasInDocument: () => {
    // Replace $...$ with {{F001:value}} markers.
    const { superdoc, formulaStore, blocks } = get();
    if (!superdoc || !formulaStore) return;

    try {
      const ed = (superdoc as { activeEditor?: { doc: { find: (input: { select: { type: string; pattern: string } }) => { total: number; items: Array<{ address: { blockId?: string; nodeId?: string; nodeType?: string } }> }; replace: (input: { target: unknown; content: unknown }) => { success?: boolean } } } })?.activeEditor;
      if (!ed?.doc) return;

      for (const f of formulaStore.formulas) {
        if (!f.latex || !f.inDocument) continue;
        const patterns = [`$${f.latex}$`, `$$${f.latex}$$`];
        for (const pattern of patterns) {
          const findResult = ed.doc.find({ select: { type: "text", pattern } });
          if (findResult.total > 0 && findResult.items[0]) {
            const target = findResult.items[0].address;
            const blockId = target.blockId || target.nodeId;
            if (blockId) {
              const marker = makeMarker(f);
              ed.doc.replace({
                target: { kind: "block", nodeType: target.nodeType || "paragraph", nodeId: blockId },
                content: { kind: "paragraph", paragraph: { inlines: [{ kind: "run", run: { text: marker } }] } },
              });
              console.log("[replaceFormulas]", pattern, "→", marker);
            }
          }
        }
      }
    } catch (e) {
      console.error("[replaceFormulas] failed:", e);
    }
  },

  // ── Auto-fill actions ──────────────────────────────────────────────────
  createAutoFillField: (label, description, replaceText, variants) => {
    const { autoFillStore, superdoc } = get();
    const id = nextAutoFillFieldId(autoFillStore.fields);
    const field: AutoFillField = {
      id,
      label: label || `Поле ${id}`,
      description: description || "",
      originalText: replaceText || "",
      variants: variants || [],
      selectedValue: null,
      syncGroupId: null,
      insertMode: "single",
    };
    set({
      autoFillStore: {
        ...autoFillStore,
        fields: [...autoFillStore.fields, field],
      },
    });

    // If replaceText is provided, find it in the document and replace with marker
    if (replaceText && superdoc) {
      try {
        const ed = (superdoc as { activeEditor?: { doc: { find: (input: { select: { type: string; pattern: string } }) => { total: number; items: Array<{ address: { blockId?: string; nodeId?: string; nodeType?: string } }> }; replace: (input: { target: unknown; content: unknown }) => { success?: boolean } } } })?.activeEditor;
        if (ed?.doc) {
          const findResult = ed.doc.find({ select: { type: "text", pattern: replaceText } });
          if (findResult.total > 0 && findResult.items[0]) {
            const target = findResult.items[0].address;
            const blockId = target.blockId || target.nodeId;
            if (blockId) {
              const marker = makeAutoFillMarker(id);
              ed.doc.replace({
                target: { kind: "block", nodeType: target.nodeType || "paragraph", nodeId: blockId },
                content: { kind: "paragraph", paragraph: { inlines: [{ kind: "run", run: { text: marker } }] } },
              });
            }
          }
        }
      } catch (e) {
        console.error("[createAutoFillField] replace failed:", e);
      }
    }
    return id;
  },

  updateAutoFillField: (id, patch) => {
    set((s) => ({
      autoFillStore: {
        ...s.autoFillStore,
        fields: s.autoFillStore.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      },
    }));
  },

  deleteAutoFillField: (id) => {
    set((s) => {
      // Find any cell links that reference this AF field and remove them
      // from all table documents (clear cell linkId + style, remove CellLink + RightPanelBlock).
      const newTableDocs = s.tableDocs.map((t) => {
        const linksToRemove = t.cellLinks.filter((l) => l.autoFillFieldId === id);
        if (linksToRemove.length === 0) return t;

        // Aggregate ALL cellIds across every link referencing this AF field
        // (a single range link has many cellIds — every one must be cleared).
        const cellIdsToRemove = new Set<string>();
        for (const l of linksToRemove) {
          for (const cid of l.cellIds) cellIdsToRemove.add(cid);
        }
        const linkIdsToRemove = new Set(linksToRemove.map((l) => l.id));

        // Clear linkId + link style from cells
        const newCells = t.cells.map((r) =>
          r.map((c) => {
            if (!c || !c.linkId || !cellIdsToRemove.has(c.linkId)) return c;
            const { linkId: _lid, style: _style, ...rest } = c;
            const newStyle = { ...c.style };
            delete newStyle.fillColor;
            delete newStyle.fontColor;
            delete newStyle.bold;
            return { ...rest, style: Object.keys(newStyle).length > 0 ? newStyle : undefined };
          }),
        );

        return {
          ...t,
          cells: newCells,
          cellLinks: t.cellLinks.filter((l) => !linkIdsToRemove.has(l.id)),
          rightPanelBlocks: t.rightPanelBlocks.filter((b) => !b.cellLinkId || !linkIdsToRemove.has(b.cellLinkId)),
          updatedAt: new Date().toISOString(),
        };
      });

      return {
        autoFillStore: {
          ...s.autoFillStore,
          fields: s.autoFillStore.fields.filter((f) => f.id !== id),
          syncGroups: s.autoFillStore.syncGroups.map((g) => ({
            ...g,
            fieldIds: g.fieldIds.filter((fid) => fid !== id),
          })).filter((g) => g.fieldIds.length > 1),
        },
        tableDocs: newTableDocs,
      };
    });
  },

  addAutoFillVariant: (fieldId, value) => {
    set((s) => ({
      autoFillStore: {
        ...s.autoFillStore,
        fields: s.autoFillStore.fields.map((f) =>
          f.id === fieldId && !f.variants.includes(value)
            ? { ...f, variants: [...f.variants, value] }
            : f
        ),
      },
    }));
  },

  setAutoFillValue: (fieldId, value, applySync = true) => {
    const { autoFillStore, tableDocs } = get();
    const field = autoFillStore.fields.find((f) => f.id === fieldId);
    if (!field) return;

    // PROTECTION: if this AF field is linked to ANY table cell that contains
    // a formula, prevent manual value changes — the value is computed by
    // the formula and should only change when the table cell changes.
    // With range links, the field may be linked to multiple cells; if ANY of
    // them is a formula cell, block (formula values must not be overwritten).
    for (const table of tableDocs) {
      const link = table.cellLinks.find((l) => l.autoFillFieldId === fieldId);
      if (!link) continue;
      // Check every linked cell (range link → many cellIds)
      const linkedIdSet = new Set(link.cellIds);
      for (const row of table.cells) {
        for (const cell of row) {
          if (cell && cell.linkId && linkedIdSet.has(cell.linkId) && cell.raw.startsWith("=")) {
            // Cell has a formula — block the manual change
            console.warn("[setAutoFillValue] Value change blocked: field is linked to a formula cell");
            return;
          }
        }
      }
    }

    // Determine the active instance suffix
    const activeSuffix = getActiveSuffix(autoFillStore, fieldId);

    // Update the active instance's selected value
    let updatedFields = autoFillStore.fields.map((f) => {
      if (f.id !== fieldId) return f;
      const instances = getFieldInstances(f).map((inst) =>
        inst.suffix === activeSuffix ? { ...inst, selectedValue: value } : inst,
      );
      return {
        ...f,
        instances,
        // Keep selectedValue in sync with primary instance for backward compat
        selectedValue: activeSuffix === "" ? value : f.selectedValue,
      };
    });

    // LIST sync: if applySync and the field is in a sync group, find linked
    // fields and auto-select the FIRST value from the synced value list (if
    // the current selection is not in the synced list).
    if (applySync && field.syncGroupId) {
      const group = autoFillStore.syncGroups.find((g) => g.id === field.syncGroupId);
      if (group) {
        const key = `${fieldId}:${value}`;
        const mapping = group.mappings[key];
        if (mapping) {
          updatedFields = updatedFields.map((f) => {
            const syncedValues = mapping[f.id];
            if (syncedValues && syncedValues.length > 0 && f.id !== fieldId) {
              // Auto-select the first synced value if current selection
              // is not in the synced list
              const currentVal = getInstanceValue(f, "");
              if (!currentVal || !syncedValues.includes(currentVal)) {
                const newVal = syncedValues[0];
                const instances = getFieldInstances(f).map((inst) =>
                  inst.suffix === "" ? { ...inst, selectedValue: newVal } : inst,
                );
                return { ...f, instances, selectedValue: newVal };
              }
            }
            return f;
          });
        }
      }
    }

    set({ autoFillStore: { ...autoFillStore, fields: updatedFields } });

    // REVERSE SYNC: if this AF field is linked to exactly ONE table cell
    // (single-cell link) that does NOT contain a formula, update the cell's
    // value to match the new AF value. For range links (multiple cells), the
    // cells hold distinct variant values — picking one variant in the AF
    // combobox must NOT overwrite any cell, so reverse sync is skipped.
    // (Formula cells are always protected — their value comes from the formula.)
    const { tableDocs: currentDocs } = get();
    let docsChanged = false;
    const newTableDocs = currentDocs.map((t) => {
      const link = t.cellLinks.find((l) => l.autoFillFieldId === fieldId);
      if (!link || link.cellIds.length !== 1) return t;
      const targetCellId = link.cellIds[0];

      const newCells = t.cells.map((r) =>
        r.map((c) => {
          if (!c || c.linkId !== targetCellId) return c;
          if (c.raw.startsWith("=")) return c; // formula cells are protected
          if (c.raw === value) return c; // no change
          docsChanged = true;
          return { ...c, raw: value, computed: value };
        }),
      );
      return docsChanged ? { ...t, cells: newCells, updatedAt: new Date().toISOString() } : t;
    });
    if (docsChanged) {
      set({ tableDocs: newTableDocs });
    }

    // If we're in view mode, re-apply the substitution so the document
    // immediately reflects the new selected value.
    if (get().editorMode === "view") {
      if (autoFillViewRefreshTimer) clearTimeout(autoFillViewRefreshTimer);
      autoFillViewRefreshTimer = setTimeout(() => {
        const { editorMode, bridge, ready } = get();
        if (editorMode === "view" && bridge && ready) {
          console.log("[setAutoFillValue] re-applying view substitution");
          get().setEditorMode("edit");
          setTimeout(() => {
            if (get().editorMode === "edit") {
              get().setEditorMode("view");
            }
          }, 800);
        }
      }, 600);
    }
  },

  setAutoFillInstanceValue: (fieldId, suffix, value) => {
    const { autoFillStore } = get();
    set({
      autoFillStore: {
        ...autoFillStore,
        fields: autoFillStore.fields.map((f) => {
          if (f.id !== fieldId) return f;
          const instances = getFieldInstances(f).map((inst) =>
            inst.suffix === suffix ? { ...inst, selectedValue: value } : inst,
          );
          return {
            ...f,
            instances,
            selectedValue: suffix === "" ? value : f.selectedValue,
          };
        }),
      },
    });
    if (get().editorMode === "view") {
      if (autoFillViewRefreshTimer) clearTimeout(autoFillViewRefreshTimer);
      autoFillViewRefreshTimer = setTimeout(() => {
        if (get().editorMode === "view" && get().bridge && get().ready) {
          get().setEditorMode("edit");
          setTimeout(() => {
            if (get().editorMode === "edit") get().setEditorMode("view");
          }, 800);
        }
      }, 600);
    }
  },

  createAutoFillInstance: (fieldId) => {
    const { autoFillStore, superdoc } = get();
    const field = autoFillStore.fields.find((f) => f.id === fieldId);
    if (!field) return "";
    const suffix = nextInstanceSuffix(field);
    const newInstance = { suffix, selectedValue: null };
    const updatedFields = autoFillStore.fields.map((f) => {
      if (f.id !== fieldId) return f;
      const instances = [...getFieldInstances(f), newInstance];
      return { ...f, instances };
    });
    set({
      autoFillStore: {
        ...autoFillStore,
        fields: updatedFields,
        activeInstance: { ...autoFillStore.activeInstance, [fieldId]: suffix },
      },
    });
    // Insert the marker for the new instance into the document
    if (superdoc) {
      try {
        const ed = (superdoc as { activeEditor?: { doc: { insert: (input: { value: string; type?: string }) => unknown } } })?.activeEditor;
        const marker = makeMarkerForInstance(fieldId, suffix);
        ed?.doc.insert({ value: marker, type: "text" });
      } catch (e) {
        console.error("[createAutoFillInstance] insert marker failed:", e);
      }
    }
    return suffix;
  },

  deleteAutoFillInstance: (fieldId, suffix) => {
    if (suffix === "") return; // cannot delete primary instance
    const { autoFillStore } = get();
    set({
      autoFillStore: {
        ...autoFillStore,
        fields: autoFillStore.fields.map((f) => {
          if (f.id !== fieldId) return f;
          const instances = getFieldInstances(f).filter((i) => i.suffix !== suffix);
          return { ...f, instances };
        }),
        activeInstance: {
          ...autoFillStore.activeInstance,
          [fieldId]: autoFillStore.activeInstance?.[fieldId] === suffix ? "" : autoFillStore.activeInstance?.[fieldId],
        },
      },
    });
  },

  setActiveAutoFillInstance: (fieldId, suffix) => {
    const { autoFillStore } = get();
    set({
      autoFillStore: {
        ...autoFillStore,
        activeInstance: { ...autoFillStore.activeInstance, [fieldId]: suffix },
      },
    });
  },

  insertAutoFillInstanceMarker: (fieldId, suffix) => {
    const { superdoc } = get();
    if (!superdoc) return;
    try {
      const ed = (superdoc as { activeEditor?: { doc: { insert: (input: { value: string; type?: string }) => unknown } } })?.activeEditor;
      const marker = makeMarkerForInstance(fieldId, suffix);
      ed?.doc.insert({ value: marker, type: "text" });
    } catch (e) {
      console.error("[insertAutoFillInstanceMarker] failed:", e);
    }
  },

  startAutoFillSyncMode: () => {
    set({ autoFillSyncMode: true, autoFillSyncDraft: {} });
  },

  cancelAutoFillSyncMode: () => {
    set({ autoFillSyncMode: false, autoFillSyncDraft: {} });
  },

  setAutoFillSyncDraftValue: (fieldId, value) => {
    set((s) => {
      const current = s.autoFillSyncDraft[fieldId] || [];
      // Toggle: if value already in draft, remove it; otherwise add it
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return {
        autoFillSyncDraft: { ...s.autoFillSyncDraft, [fieldId]: next },
      };
    });
  },

  clearAutoFillSyncDraft: (fieldId) => {
    set((s) => {
      const next = { ...s.autoFillSyncDraft };
      delete next[fieldId];
      return { autoFillSyncDraft: next };
    });
  },

  toggleAutoFillSyncMode: () => {
    const { autoFillSyncMode } = get();
    if (autoFillSyncMode) {
      get().cancelAutoFillSyncMode();
    } else {
      get().startAutoFillSyncMode();
    }
  },

  createAutoFillSyncGroup: (fieldIds) => {
    const { autoFillStore } = get();
    const groupId = `SYNC${Date.now().toString(36)}`;
    const group: AutoFillSyncGroup = {
      id: groupId,
      fieldIds,
      mappings: {},
    };
    set({
      autoFillStore: {
        ...autoFillStore,
        syncGroups: [...autoFillStore.syncGroups, group],
        fields: autoFillStore.fields.map((f) =>
          fieldIds.includes(f.id) ? { ...f, syncGroupId: groupId, insertMode: "sync" } : f
        ),
      },
    });
    return groupId;
  },

  deleteAutoFillSyncGroup: (groupId) => {
    const { autoFillStore } = get();
    set({
      autoFillStore: {
        ...autoFillStore,
        syncGroups: autoFillStore.syncGroups.filter((g) => g.id !== groupId),
        fields: autoFillStore.fields.map((f) =>
          f.syncGroupId === groupId
            ? { ...f, syncGroupId: null, insertMode: "single" }
            : f,
        ),
      },
    });
  },

  saveAutoFillSyncMappings: () => {
    const { autoFillStore, autoFillSyncMode, autoFillSyncDraft } = get();
    if (!autoFillSyncMode) return;

    // Collect the fields that have draft selections (arrays of values)
    const draftFieldIds = Object.keys(autoFillSyncDraft).filter(
      (fid) => autoFillSyncDraft[fid].length > 0,
    );
    if (draftFieldIds.length < 2) {
      console.warn("[saveAutoFillSyncMappings] need ≥2 fields with draft selections");
      set({ autoFillSyncMode: false, autoFillSyncDraft: {} });
      return;
    }

    // Check if these fields already share a sync group
    const existingGroupIds = draftFieldIds
      .map((fid) => autoFillStore.fields.find((f) => f.id === fid)?.syncGroupId)
      .filter((gid): gid is string => !!gid);
    const sharedGroupId = existingGroupIds.length > 0 &&
      existingGroupIds.every((gid) => gid === existingGroupIds[0])
      ? existingGroupIds[0]
      : null;

    const groupId = sharedGroupId || `SYNC${Date.now().toString(36)}`;
    const existingGroup = autoFillStore.syncGroups.find((g) => g.id === groupId);

    // Build bidirectional LIST mappings from the draft.
    // For each field:value pair, create a mapping: the OTHER fields get the
    // FULL LIST of that field's draft values.
    const newMappings: Record<string, Record<string, string[]>> =
      existingGroup ? { ...existingGroup.mappings } : {};

    for (const keyFieldId of draftFieldIds) {
      const keyValues = autoFillSyncDraft[keyFieldId];
      for (const keyValue of keyValues) {
        const key = `${keyFieldId}:${keyValue}`;
        const mapping: Record<string, string[]> = {};
        for (const otherFieldId of draftFieldIds) {
          if (otherFieldId === keyFieldId) continue;
          // The other field's full draft list becomes the synced values
          mapping[otherFieldId] = [...autoFillSyncDraft[otherFieldId]];
        }
        if (Object.keys(mapping).length > 0) {
          newMappings[key] = { ...(newMappings[key] || {}), ...mapping };
        }
      }
    }

    // Update the store
    let updatedSyncGroups: AutoFillSyncGroup[];
    if (existingGroup) {
      updatedSyncGroups = autoFillStore.syncGroups.map((g) =>
        g.id === groupId ? { ...g, mappings: newMappings } : g,
      );
    } else {
      updatedSyncGroups = [
        ...autoFillStore.syncGroups,
        { id: groupId, fieldIds: draftFieldIds, mappings: newMappings },
      ];
    }

    set({
      autoFillStore: {
        ...autoFillStore,
        syncGroups: updatedSyncGroups,
        fields: autoFillStore.fields.map((f) =>
          draftFieldIds.includes(f.id)
            ? { ...f, syncGroupId: groupId, insertMode: "sync" }
            : f,
        ),
      },
      autoFillSyncMode: false,
      autoFillSyncDraft: {},
    });
  },

  setAutoFillXmlEditorOpen: (open) => set({ autoFillXmlEditorOpen: open }),

  setAutoFillVariantFilter: (filter) => {
    set((s) => ({ autoFillStore: { ...s.autoFillStore, variantFilter: filter } }));
  },

  setAutoFillStore: (store) => {
    const { tableDocs, autoFillStore: oldStore } = get();

    // REVERSE SYNC: for each field in the new store that is linked to a table
    // cell (non-formula), if the selectedValue changed, update the table cell.
    let docsChanged = false;
    const newTableDocs = tableDocs.map((t) => {
      let tableChanged = false;
      const newCells = t.cells.map((r) => r.slice());

      for (const link of t.cellLinks) {
        // Only single-cell links get reverse-synced (range links have multiple variants)
        if (link.cellIds.length !== 1) continue;

        const newField = store.fields.find((f) => f.id === link.autoFillFieldId);
        const oldField = oldStore.fields.find((f) => f.id === link.autoFillFieldId);
        if (!newField || !oldField) continue;

        const newVal = newField.selectedValue;
        const oldVal = oldField.selectedValue;
        if (newVal === oldVal) continue; // no change

        // Find the linked cell
        const cellId = link.cellIds[0];
        for (let r = 0; r < newCells.length; r++) {
          for (let c = 0; c < newCells[r].length; c++) {
            const cell = newCells[r][c];
            if (cell && cell.linkId === cellId) {
              // Skip formula cells — they're protected
              if (cell.raw.startsWith("=")) continue;
              // Update the cell value
              newCells[r][c] = { ...cell, raw: newVal || "", computed: newVal || "" };
              tableChanged = true;
              docsChanged = true;
            }
          }
        }
      }

      return tableChanged ? { ...t, cells: newCells, updatedAt: new Date().toISOString() } : t;
    });

    set({
      autoFillStore: store,
      ...(docsChanged ? { tableDocs: newTableDocs } : {}),
    });

    // IMMEDIATE FORMULA RECALCULATION: if any table cells were updated via
    // reverse sync, re-evaluate formulas in ALL changed tables right away.
    // This ensures formula cells (e.g. =B3+B2) reflect the new input values
    // without waiting for the user to open the table editor.
    // Then sync the recalculated values back to the AF store.
    if (docsChanged) {
      // Use setTimeout to let the set() above flush first, then evaluate.
      setTimeout(async () => {
        const currentDocs = get().tableDocs;
        let afNeedsSync = false;
        const recalcedDocs = currentDocs.map((t) => {
          // Only recalculate tables that have formula cells
          let hasFormula = false;
          for (const row of t.cells) {
            if (!row) continue;
            for (const cell of row) {
              if (cell?.raw?.startsWith("=")) { hasFormula = true; break; }
            }
            if (hasFormula) break;
          }
          if (!hasFormula) return t;

          const evaluated = evaluateTable(t.cells);
          afNeedsSync = true;
          return { ...t, cells: evaluated, updatedAt: new Date().toISOString() };
        });

        if (afNeedsSync) {
          set({ tableDocs: recalcedDocs });
          // Sync the recalculated formula values back to AF fields
          for (const t of recalcedDocs) {
            get().syncCellLinksToAutoFill(t.id);
          }
        }
      }, 50); // Small delay to let math.js CDN load if needed
    }
  },

  insertAutoFillMarker: (fieldId) => {
    const { superdoc } = get();
    if (!superdoc) return;
    try {
      const ed = (superdoc as { activeEditor?: { doc: { insert: (input: { value: string; type?: string }) => unknown } } })?.activeEditor;
      const marker = makeAutoFillMarker(fieldId);
      ed?.doc.insert({ value: marker, type: "text" });
    } catch (e) {
      console.error("[insertAutoFillMarker] failed:", e);
    }
  },

  // ── Table editor actions ──────────────────────────────────────────────
  createTableDoc: (name) => {
    const id = `T${String(get().tableDocs.length + 1).padStart(3, "0")}`;
    const safeName = (name || "Новая таблица").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100);
    const now = new Date().toISOString();
    const doc: TableDoc = {
      id,
      name: safeName,
      cells: [],
      merges: [],
      zones: [],
      cellLinks: [],
      rightPanelBlocks: [],
      colWidths: [],
      rowHeights: [],
      rowCount: 50,
      colCount: 39,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ tableDocs: [...s.tableDocs, doc], tableEditorOpenId: id }));
    return id;
  },

  openTableEditor: (id) => set({ tableEditorOpenId: id }),

  closeTableEditor: () => set({ tableEditorOpenId: null }),

  updateTableDoc: (id, patch) => {
    set((s) => ({
      tableDocs: s.tableDocs.map((d) =>
        d.id === id ? { ...d, ...patch, updatedAt: new Date().toISOString() } : d,
      ),
    }));
  },

  deleteTableDoc: (id) => {
    set((s) => ({
      tableDocs: s.tableDocs.filter((d) => d.id !== id),
      tableEditorOpenId: s.tableEditorOpenId === id ? null : s.tableEditorOpenId,
    }));
  },

  renameTableDoc: (id, name) => {
    const safeName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100);
    get().updateTableDoc(id, { name: safeName });
  },

  setTableDocs: (docs) => set({ tableDocs: docs }),

  // ── Cell link actions (table ↔ auto-fill integration) ────────────────
  createCellLink: (tableId, cells, label, description) => {
    const { tableDocs, autoFillStore } = get();
    const table = tableDocs.find((t) => t.id === tableId);
    if (!table || cells.length === 0) return "";

    // 1. Generate ONE linkId + ONE afFieldId. Each cell gets its own UNIQUE
    //    cellId (`CID<ts>__<i>`) so cells in a range don't collide.
    const linkId = `CL${String(table.cellLinks.length + 1).padStart(3, "0")}`;
    const afFieldId = nextAutoFillFieldId(autoFillStore.fields);
    const now = Date.now();
    const cellIds: string[] = cells.map((_, i) => `CID${now.toString(36)}__${i}`);

    // 2. Collect each cell's current value — use computed (result) for
    //    formula cells, NEVER the raw formula text. Empty values are kept
    //    (syncCellLinksToAutoFill will refresh them after formula eval).
    const cellValues: string[] = cells.map(({ row, col }) => {
      const cell = table.cells[row]?.[col];
      if (!cell) return "";
      if (cell.computed != null) return String(cell.computed);
      if (cell.raw && !cell.raw.startsWith("=")) return cell.raw;
      return "";
    });

    // 3. Apply link style + assign cellId as linkId to ALL cells.
    //    First ensure the grid is large enough for every selected cell.
    const newCells = table.cells.map((r) => r.slice());
    let maxRow = -1;
    let maxCol = -1;
    for (const { row, col } of cells) {
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
    while (newCells.length <= maxRow) newCells.push([]);
    for (const { row, col } of cells) {
      const cellRow = newCells[row];
      while (cellRow.length <= col) cellRow.push(null);
    }
    cells.forEach(({ row, col }, i) => {
      const cellId = cellIds[i];
      const cellRow = newCells[row];
      const existingCell = cellRow[col];
      cellRow[col] = {
        ...(existingCell || { raw: "", computed: null }),
        linkId: cellId,
        style: {
          ...(existingCell?.style || {}),
          fillColor: "#dbeafe", // light blue background
          fontColor: "#1e40af", // dark blue text
          bold: true,
        },
      };
    });

    // 4. Build a human-readable coordinate label (single → "A1", range → "A1:A5").
    const firstCell = cells[0];
    const lastCell = cells[cells.length - 1];
    const coordLabel =
      cells.length === 1
        ? toCellRef(firstCell.row, firstCell.col)
        : `${toCellRef(firstCell.row, firstCell.col)}:${toCellRef(lastCell.row, lastCell.col)}`;
    const effectiveLabel = label || `Ячейка ${coordLabel}`;

    // 5. Create ONE CellLink record with cellIds: string[] (all cell IDs).
    const newLink: CellLink = {
      id: linkId,
      autoFillFieldId: afFieldId,
      cellIds,
      label: effectiveLabel,
      description: description || "",
    };

    // 6. Create ONE RightPanelBlock anchored at the first cell's row.
    //    ID uses a random suffix to avoid Date.now() collision with
    //    other blocks created in the same tick.
    const newBlock: RightPanelBlock = {
      id: `RPB${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: "autofill-link",
      row: firstCell.row,
      cellLinkId: linkId,
      offsetX: 0,
    };

    // 7. Create ONE AutoFillField — variants = ALL cell values,
    //    selectedValue = first value (user can change later).
    const selectedValue = cellValues[0] ?? "";
    const newAfField: AutoFillField = {
      id: afFieldId,
      label: effectiveLabel,
      description:
        description ||
        `Связано с таблицей "${table.name}", ячейки ${coordLabel}`,
      originalText: "",
      variants: cellValues.length > 0 ? cellValues : [""],
      selectedValue,
      syncGroupId: null,
      insertMode: "single",
      instances: [{ suffix: "", selectedValue }],
    };

    set({
      tableDocs: tableDocs.map((t) =>
        t.id === tableId
          ? {
              ...t,
              cells: newCells,
              cellLinks: [...t.cellLinks, newLink],
              rightPanelBlocks: [...t.rightPanelBlocks, newBlock],
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
      autoFillStore: {
        ...autoFillStore,
        fields: [...autoFillStore.fields, newAfField],
      },
    });

    return linkId;
  },

  deleteCellLink: (tableId, linkId) => {
    const { tableDocs, autoFillStore } = get();
    const table = tableDocs.find((t) => t.id === tableId);
    if (!table) return;

    const link = table.cellLinks.find((l) => l.id === linkId);
    if (!link) return;

    // 1. Clear linkId + link style from EVERY cell in the link's cellIds.
    //    (A range link has many cellIds — all must be cleared.)
    const cellIdSet = new Set(link.cellIds);
    const newCells = table.cells.map((r) =>
      r.map((c) => {
        if (!c || !c.linkId || !cellIdSet.has(c.linkId)) return c;
        const { linkId: _lid, style: _style, ...rest } = c;
        // Remove link-specific style properties
        const newStyle = { ...c.style };
        delete newStyle.fillColor;
        delete newStyle.fontColor;
        delete newStyle.bold;
        return { ...rest, style: Object.keys(newStyle).length > 0 ? newStyle : undefined };
      }),
    );

    set({
      tableDocs: tableDocs.map((t) =>
        t.id === tableId
          ? {
              ...t,
              cells: newCells,
              cellLinks: t.cellLinks.filter((l) => l.id !== linkId),
              rightPanelBlocks: t.rightPanelBlocks.filter((b) => b.cellLinkId !== linkId),
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
      autoFillStore: {
        ...autoFillStore,
        fields: autoFillStore.fields.filter((f) => f.id !== link.autoFillFieldId),
      },
    });
  },

  updateRightPanelBlockOffset: (tableId, blockId, offsetX) => {
    set((s) => ({
      tableDocs: s.tableDocs.map((t) =>
        t.id === tableId
          ? {
              ...t,
              rightPanelBlocks: t.rightPanelBlocks.map((b) =>
                b.id === blockId ? { ...b, offsetX } : b,
              ),
            }
          : t,
      ),
    }));
  },

  syncCellLinksToAutoFill: (tableId) => {
    const { tableDocs, autoFillStore } = get();
    const table = tableDocs.find((t) => t.id === tableId);
    if (!table || table.cellLinks.length === 0) return;

    // Build a map cellId → cell value (live values from the current grid).
    // Each linked cell stores its cellId in `Cell.linkId`, so we look it up.
    const cellValuesByCellId = new Map<string, string>();
    for (const row of table.cells) {
      if (!row) continue;
      for (const cell of row) {
        if (cell?.linkId) {
          cellValuesByCellId.set(cell.linkId, String(cell.computed ?? cell.raw ?? ""));
        }
      }
    }

    // For each CellLink: collect ALL cell values (one per cellId), update the
    // AF field's `variants` array, and keep `selectedValue` as the user's
    // choice — unless it's no longer in variants (then fall back to first).
    let updatedFields = autoFillStore.fields;
    let changed = false;

    for (const link of table.cellLinks) {
      // Find every linked cell by its cellId and collect values.
      // Empty values are filtered out (e.g. formula cells with null computed).
      const values: string[] = [];
      for (const cid of link.cellIds) {
        const v = cellValuesByCellId.get(cid);
        if (v != null && v !== "") values.push(v);
      }
      const variants = values.length > 0 ? values : [""];

      const fieldIdx = updatedFields.findIndex((f) => f.id === link.autoFillFieldId);
      if (fieldIdx >= 0) {
        const field = updatedFields[fieldIdx];
        // Preserve user's selectedValue if it's still a valid variant;
        // otherwise fall back to the first value (or empty).
        const newSelected = values.includes(field.selectedValue ?? "")
          ? field.selectedValue
          : values[0] ?? "";

        const variantsChanged =
          field.variants.length !== variants.length ||
          field.variants.some((v, i) => v !== variants[i]);
        const selectedChanged = field.selectedValue !== newSelected;

        if (variantsChanged || selectedChanged) {
          updatedFields = updatedFields.map((f, i) =>
            i === fieldIdx
              ? {
                  ...f,
                  variants,
                  selectedValue: newSelected,
                  instances: (f.instances || [
                    { suffix: "", selectedValue: null },
                  ]).map((inst) =>
                    inst.suffix === "" ? { ...inst, selectedValue: newSelected } : inst,
                  ),
                }
              : f,
          );
          changed = true;
        }
      }
    }

    if (changed) {
      set({ autoFillStore: { ...autoFillStore, fields: updatedFields } });
    }
  },

  // ── Formula link actions (table ↔ calculator integration) ─────────────
  createFormulaLink: (tableId, cells, formulaId, label, description) => {
    const { tableDocs, formulaStore } = get();
    const table = tableDocs.find((t) => t.id === tableId);
    if (!table || cells.length === 0 || !formulaStore) return "";

    const formula = formulaStore.formulas.find((f) => f.id === formulaId);
    if (!formula) return "";

    // Determine the link kind from the formula classification + cell count.
    // - Matrix formula + range → matrix link (kind "formula", multiple cells).
    // - Function formula → function link (single cell, read-only).
    // - Constant formula → constant link (single cell, editable).
    const isMatrix = isMatrixFormula(formula.formula);
    const kind: "constant" | "function" | "matrix" = isMatrix
      ? "matrix"
      : classifyFormula(formula) === "function"
        ? "function"
        : "constant";

    // 1. Generate IDs.
    const linkId = `FL${String(table.cellLinks.length + 1).padStart(3, "0")}`;
    const now = Date.now();
    const cellIds: string[] = cells.map((_, i) => `FID${now.toString(36)}__${i}`);

    // 2. Apply link style + assign formulaLinkId to ALL cells.
    //    Brick-red palette (distinct from AutoFill's blue).
    const newCells = table.cells.map((r) => r.slice());
    let maxRow = -1;
    let maxCol = -1;
    for (const { row, col } of cells) {
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
    while (newCells.length <= maxRow) newCells.push([]);
    for (const { row, col } of cells) {
      const cellRow = newCells[row];
      while (cellRow.length <= col) cellRow.push(null);
    }

    // For function links: the cell is read-only and shows the computed value.
    // Set raw to "=" + formula expression so the formula bar displays it.
    // For constant links: keep existing cell value (editable).
    // For matrix links: keep existing cell values (editable, feed the matrix).
    cells.forEach(({ row, col }, i) => {
      const cellId = cellIds[i];
      const cellRow = newCells[row];
      const existingCell = cellRow[col];
      const base: Cell = existingCell
        ? { ...existingCell }
        : { raw: "", computed: null };
      if (kind === "function") {
        // Read-only: raw = "=" + formula expr (so formula bar shows it).
        // computed will be filled by pushFormulaValuesToCells.
        base.raw = `=${formula.formula}`;
        base.computed = formula.value ?? null;
      } else if (kind === "constant" && i === 0) {
        // Constant link: if the cell is empty, seed it with the formula value.
        if ((!base.raw || base.raw === "") && formula.value !== undefined) {
          base.raw = String(formula.value);
          base.computed = formula.value;
        }
      } else if (kind === "matrix") {
        // Matrix link: if cells are empty, seed them from the matrix literal.
        // Parse the matrix and fill cells row-by-row.
        // (Done only on link creation; subsequent edits sync bidirectionally.)
      }
      base.formulaLinkId = linkId;
      base.style = {
        ...(existingCell?.style || {}),
        fillColor: "#fee2e2", // light brick-red background
        fontColor: "#991b1b", // dark brick-red text
        bold: true,
      };
      cellRow[col] = base;
    });

    // For matrix links: seed empty cells from the matrix literal.
    if (kind === "matrix") {
      try {
        const math = getMath();
        if (math) {
          const val = math.evaluate(formula.formula);
          const arr =
            typeof val?.toArray === "function" ? val.toArray() : val;
          if (Array.isArray(arr)) {
            // Determine the selection shape (rows × cols), row-major.
            const rowSet = new Set(cells.map((c) => c.row));
            const selRows = Array.from(rowSet).sort((a, b) => a - b);
            const colSet = new Set(cells.map((c) => c.col));
            const selCols = Array.from(colSet).sort((a, b) => a - b);
            cells.forEach(({ row, col }) => {
              const localRow = selRows.indexOf(row);
              const localCol = selCols.indexOf(col);
              const matrixRow = arr[localRow];
              const v = Array.isArray(matrixRow)
                ? matrixRow[localCol]
                : localCol === 0
                  ? matrixRow
                  : 0;
              const cellRow = newCells[row];
              const cell = cellRow[col];
              if (cell && (!cell.raw || cell.raw === "")) {
                const n = Number(v);
                if (!isNaN(n)) {
                  cell.raw = String(n);
                  cell.computed = n;
                }
              }
            });
          }
        }
      } catch {
        // Ignore — leave cells empty.
      }
    }

    // 3. Build the CellLink record.
    const firstCell = cells[0];
    const lastCell = cells[cells.length - 1];
    const coordLabel =
      cells.length === 1
        ? toCellRef(firstCell.row, firstCell.col)
        : `${toCellRef(firstCell.row, firstCell.col)}:${toCellRef(lastCell.row, lastCell.col)}`;
    const effectiveLabel = label || `${formula.name} @ ${coordLabel}`;

    const newLink: CellLink = {
      id: linkId,
      kind: "formula",
      autoFillFieldId: "", // not used for formula links
      formulaId,
      cellIds,
      label: effectiveLabel,
      description: description || "",
    };

    // 4. Create a RightPanelBlock of type "calculator-var".
    const newBlock: RightPanelBlock = {
      id: `RPBF${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: "calculator-var",
      row: firstCell.row,
      cellLinkId: linkId,
      offsetX: 0,
      showFormulaLatex: false,
    };

    set({
      tableDocs: tableDocs.map((t) =>
        t.id === tableId
          ? {
              ...t,
              cells: newCells,
              cellLinks: [...t.cellLinks, newLink],
              rightPanelBlocks: [...t.rightPanelBlocks, newBlock],
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
    });

    // 5. For constant links: push the cell value → FormulaEntry immediately.
    //    For function links: the value flows formula→cell (pushFormulaValuesToCells).
    //    For matrix links: serialize the range → FormulaEntry.formula.
    if (kind === "constant") {
      const cell = newCells[firstCell.row][firstCell.col];
      const v = cell?.computed ?? cell?.raw;
      const n = v != null ? Number(v) : NaN;
      if (!isNaN(n)) {
        get().updateFormulaStore({
          formulas: formulaStore.formulas.map((f) =>
            f.id === formulaId
              ? { ...f, formula: String(n), value: n }
              : f,
          ),
        });
      }
    } else if (kind === "matrix") {
      // Serialize the range into a matrix literal and store as the formula.
      const rangeRows: (Cell | null)[][] = [];
      const rowSet = new Set(cells.map((c) => c.row));
      const rows = Array.from(rowSet).sort((a, b) => a - b);
      const colSet = new Set(cells.map((c) => c.col));
      const cols = Array.from(colSet).sort((a, b) => a - b);
      for (const r of rows) {
        const rowCells: (Cell | null)[] = [];
        for (const c of cols) {
          rowCells.push(newCells[r][c]);
        }
        rangeRows.push(rowCells);
      }
      const matrixLiteral = serializeMatrix(rangeRows);
      get().updateFormulaStore({
        formulas: formulaStore.formulas.map((f) =>
          f.id === formulaId ? { ...f, formula: matrixLiteral } : f,
        ),
      });
    }

    return linkId;
  },

  deleteFormulaLink: (tableId, linkId) => {
    const { tableDocs } = get();
    const table = tableDocs.find((t) => t.id === tableId);
    if (!table) return;

    const link = table.cellLinks.find((l) => l.id === linkId);
    if (!link) return;

    // Clear formulaLinkId + brick-red style from every cell in the link.
    // Cells store formulaLinkId === link.id (not the internal cellId).
    const newCells = table.cells.map((r) =>
      r.map((c) => {
        if (!c || c.formulaLinkId !== linkId) return c;
        const newStyle = { ...c.style };
        delete newStyle.fillColor;
        delete newStyle.fontColor;
        delete newStyle.bold;
        const { formulaLinkId: _flid, ...rest } = c;
        return {
          ...rest,
          style: Object.keys(newStyle).length > 0 ? newStyle : undefined,
        };
      }),
    );

    set({
      tableDocs: tableDocs.map((t) =>
        t.id === tableId
          ? {
              ...t,
              cells: newCells,
              cellLinks: t.cellLinks.filter((l) => l.id !== linkId),
              rightPanelBlocks: t.rightPanelBlocks.filter(
                (b) => b.cellLinkId !== linkId,
              ),
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
    });
  },

  syncCellLinksToFormulas: (tableId) => {
    const { tableDocs, formulaStore } = get();
    const table = tableDocs.find((t) => t.id === tableId);
    if (!table || !formulaStore) return;
    if (table.cellLinks.length === 0) return;

    // Only process formula links.
    const formulaLinks = table.cellLinks.filter((l) => l.kind === "formula");
    if (formulaLinks.length === 0) return;

    // Build cellId → cell value map.
    const cellById = new Map<string, Cell>();
    for (const row of table.cells) {
      if (!row) continue;
      for (const cell of row) {
        if (cell?.formulaLinkId) cellById.set(cell.formulaLinkId, cell);
      }
    }

    let formulasChanged = false;
    let newFormulas = formulaStore.formulas;

    for (const link of formulaLinks) {
      const formula = newFormulas.find((f) => f.id === link.formulaId);
      if (!formula) continue;

      // Determine the link kind by re-classifying.
      const isMatrix = isMatrixFormula(formula.formula);
      const kind: "constant" | "function" | "matrix" = isMatrix
        ? "matrix"
        : classifyFormula(formula) === "function"
          ? "function"
          : "constant";

      if (kind === "function") {
        // Function links: value flows formula→cell, skip.
        continue;
      }

      if (kind === "constant") {
        // Single cell → FormulaEntry.value.
        // The cell's formulaLinkId stores the CellLink.id (e.g. "FL001").
        const cell = cellById.get(link.id);
        if (!cell) continue;
        const v = cell.computed ?? cell.raw;
        const n = v != null && v !== "" ? Number(v) : NaN;
        if (isNaN(n)) continue;
        const oldVal = formula.value;
        const oldFormula = formula.formula;
        if (oldVal !== n || oldFormula !== String(n)) {
          newFormulas = newFormulas.map((f) =>
            f.id === formula.id
              ? { ...f, formula: String(n), value: n }
              : f,
          );
          formulasChanged = true;
        }
      } else if (kind === "matrix") {
        // Range → FormulaEntry.formula (matrix literal).
        // Collect cells by their (row, col) position.
        // Match cells whose formulaLinkId === link.id.
        const positioned: Array<{ row: number; col: number; cell: Cell }> = [];
        for (let rowIdx = 0; rowIdx < table.cells.length; rowIdx++) {
          const row = table.cells[rowIdx];
          if (!row) continue;
          for (let col = 0; col < row.length; col++) {
            const cell = row[col];
            if (cell?.formulaLinkId === link.id) {
              positioned.push({ row: rowIdx, col, cell });
            }
          }
        }
        if (positioned.length === 0) continue;
        const rows = Array.from(new Set(positioned.map((p) => p.row))).sort(
          (a, b) => a - b,
        );
        const cols = Array.from(new Set(positioned.map((p) => p.col))).sort(
          (a, b) => a - b,
        );
        const matrix: (Cell | null)[][] = [];
        for (const r of rows) {
          const rowCells: (Cell | null)[] = [];
          for (const c of cols) {
            const p = positioned.find((pp) => pp.row === r && pp.col === c);
            rowCells.push(p ? p.cell : null);
          }
          matrix.push(rowCells);
        }
        const matrixLiteral = serializeMatrix(matrix);
        if (formula.formula !== matrixLiteral) {
          newFormulas = newFormulas.map((f) =>
            f.id === formula.id ? { ...f, formula: matrixLiteral } : f,
          );
          formulasChanged = true;
        }
      }
    }

    if (formulasChanged) {
      // updateFormulaStore recalculates values and sets the store in one call.
      get().updateFormulaStore({ formulas: newFormulas });
    }
  },

  pushFormulaValuesToCells: (tableId) => {
    const { tableDocs, formulaStore } = get();
    const table = tableDocs.find((t) => t.id === tableId);
    if (!table || !formulaStore) return null;

    const formulaLinks = table.cellLinks.filter((l) => l.kind === "formula");
    if (formulaLinks.length === 0) return null;

    let changed = false;
    const newCells = table.cells.map((r) => r.slice());

    for (const link of formulaLinks) {
      const formula = formulaStore.formulas.find((f) => f.id === link.formulaId);
      if (!formula) continue;

      const isMatrix = isMatrixFormula(formula.formula);
      const kind: "constant" | "function" | "matrix" = isMatrix
        ? "matrix"
        : classifyFormula(formula) === "function"
          ? "function"
          : "constant";

      if (kind === "function") {
        // Push the computed value to the cell (read-only).
        // The cell's formulaLinkId stores the CellLink.id (e.g. "FL001"),
        // NOT the internal cellId (e.g. "FID..."). Match against link.id.
        for (let r = 0; r < newCells.length; r++) {
          const row = newCells[r];
          for (let c = 0; c < row.length; c++) {
            const cell = row[c];
            if (cell?.formulaLinkId === link.id) {
              const newVal = formula.value ?? null;
              if (cell.computed !== newVal) {
                row[c] = { ...cell, computed: newVal };
                changed = true;
              }
            }
          }
        }
      } else if (kind === "constant") {
        // Push the formula value to the cell IF the cell value differs.
        // (This is the reverse direction: user edited the constant in the
        // calculator UI → the cell updates.)
        const newValNum = formula.value;
        const newValStr = newValNum !== undefined ? String(newValNum) : "";
        for (let r = 0; r < newCells.length; r++) {
          const row = newCells[r];
          for (let c = 0; c < row.length; c++) {
            const cell = row[c];
            if (cell?.formulaLinkId === link.id) {
              if (cell.raw !== newValStr) {
                row[c] = { ...cell, raw: newValStr, computed: newValNum ?? null };
                changed = true;
              }
            }
          }
        }
      } else if (kind === "matrix") {
        // Push the matrix values back to the cell range.
        try {
          const math = getMath();
          if (!math) continue;
          const val = math.evaluate(formula.formula);
          const arr =
            typeof val?.toArray === "function" ? val.toArray() : val;
          if (!Array.isArray(arr)) continue;
          // Collect cells by position (row, col) sorted.
          // Match cells whose formulaLinkId === link.id (all cells in the
          // matrix range share the same link.id).
          const positioned: Array<{ row: number; col: number }> = [];
          for (let r = 0; r < newCells.length; r++) {
            const row = newCells[r];
            for (let c = 0; c < row.length; c++) {
              const cell = row[c];
              if (cell?.formulaLinkId === link.id) {
                positioned.push({ row: r, col: c });
              }
            }
          }
          if (positioned.length === 0) continue;
          const rows = Array.from(new Set(positioned.map((p) => p.row))).sort(
            (a, b) => a - b,
          );
          const cols = Array.from(new Set(positioned.map((p) => p.col))).sort(
            (a, b) => a - b,
          );
          for (const p of positioned) {
            const localRow = rows.indexOf(p.row);
            const localCol = cols.indexOf(p.col);
            const matrixRow = arr[localRow];
            const v = Array.isArray(matrixRow)
              ? matrixRow[localCol]
              : localCol === 0
                ? matrixRow
                : 0;
            const n = Number(v);
            if (isNaN(n)) continue;
            const cell = newCells[p.row][p.col];
            if (cell && cell.raw !== String(n)) {
              newCells[p.row][p.col] = { ...cell, raw: String(n), computed: n };
              changed = true;
            }
          }
        } catch {
          // Ignore.
        }
      }
    }

    if (changed) {
      set({
        tableDocs: tableDocs.map((t) =>
          t.id === tableId
            ? { ...t, cells: newCells, updatedAt: new Date().toISOString() }
            : t,
        ),
      });
      return newCells;
    }
    return null;
  },

  setRightPanelBlockShowLatex: (tableId, blockId, show) => {
    set((s) => ({
      tableDocs: s.tableDocs.map((t) =>
        t.id === tableId
          ? {
              ...t,
              rightPanelBlocks: t.rightPanelBlocks.map((b) =>
                b.id === blockId ? { ...b, showFormulaLatex: show } : b,
              ),
            }
          : t,
      ),
    }));
  },

  createFormulaFromTable: (tableId, opts) => {
    const { tableDocs, formulaStore } = get();
    const table = tableDocs.find((t) => t.id === tableId);
    if (!table || !formulaStore) return "";
    const name = opts.name.trim();
    if (!name) return "";
    if (/[^a-zA-Z0-9_]/.test(name) || /^[0-9]/.test(name)) return "";
    if (formulaStore.formulas.some((f) => f.name === name)) return "";

    // Generate the next F-number ID.
    const maxFNum = formulaStore.formulas
      .filter((f) => /^F\d+$/.test(f.id))
      .reduce((max, f) => Math.max(max, parseInt(f.id.slice(1), 10)), 0);
    const newId = `F${String(maxFNum + 1).padStart(3, "0")}`;

    let formulaExpr = opts.formula?.trim().replace(/,/g, ".") ?? "";
    let linkCells: Array<{ row: number; col: number }> | undefined;

    // Matrix/vector creation from a cell range.
    if (opts.matrixCells && opts.matrixCells.length > 0) {
      const cells = opts.matrixCells;
      const rowSet = new Set(cells.map((c) => c.row));
      const rows = Array.from(rowSet).sort((a, b) => a - b);
      const colSet = new Set(cells.map((c) => c.col));
      const cols = Array.from(colSet).sort((a, b) => a - b);
      const matrix: (Cell | null)[][] = [];
      for (const r of rows) {
        const rowCells: (Cell | null)[] = [];
        for (const c of cols) {
          rowCells.push(table.cells[r]?.[c] ?? null);
        }
        matrix.push(rowCells);
      }
      formulaExpr = serializeMatrix(matrix);
      linkCells = cells;
    }

    if (!formulaExpr) return "";

    const newFormula: FormulaEntry = {
      id: newId,
      name,
      formula: formulaExpr,
      comment: opts.comment?.trim() || undefined,
      userCreated: true,
      pinned: false,
    };

    // Add to formulaStore + recalc.
    get().updateFormulaStore({
      formulas: [...formulaStore.formulas, newFormula],
    });

    // If matrix/vector: create a matrix link to the cell range.
    if (linkCells) {
      get().createFormulaLink(
        tableId,
        linkCells,
        newId,
        `${name} (матрица)`,
        opts.comment?.trim() || "",
      );
    }

    return newId;
  },

  updateResource: (id, patch) =>
    set((s) => ({
      docMap: {
        ...s.docMap,
        externalResources: s.docMap.externalResources.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      },
    })),

  addResource: (r) =>
    set((s) => {
      const id = `R${String(s.docMap.externalResources.length + 1).padStart(3, "0")}`;
      const next = { ...r, id };
      const bridge = s.bridge;
      bridge?.setExternalResources([...s.docMap.externalResources, next]);
      return { docMap: { ...s.docMap, externalResources: [...s.docMap.externalResources, next] } };
    }),

  removeResource: (id) =>
    set((s) => ({
      docMap: { ...s.docMap, externalResources: s.docMap.externalResources.filter((r) => r.id !== id) },
    })),

  exportDocs: async (downloadName?: string) => {
    const { superdoc, docMap, blocks, llm, formulaStore } = get();
    if (!superdoc) return;
    const docxBlob = await (superdoc as { export: (o: Record<string, unknown>) => Promise<Blob> }).export({ exportType: "docx", triggerDownload: false });
    const docxBlobBase64 = await blobToBase64(docxBlob);
    const embeddings: Record<string, number[]> = {};
    for (const b of blocks) if (b.embedding) embeddings[b.id] = b.embedding;
    const mapData = { ...docMap, blocks, formulaStore: formulaStore || undefined };
    const { exportDocsBlob } = await import("@/lib/docs/docs-client");
    const blob = await exportDocsBlob({
      docxBlobBase64,
      map: mapData,
      embeddings,
      scripts: {},
      meta: { llmModel: llm.chatModel, embeddingModel: llm.embeddingModel },
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName || `${docMap.meta.title.replace(/[^\w-]+/g, "_") || "document"}.docs`;
    a.click();
    URL.revokeObjectURL(url);
  },

  printDocument: () => {
    window.print();
  },

  markDirty: () => set({ dirty: true }),
  markClean: () => set({ dirty: false }),

  saveDocs: async () => {
    const { fileName, fileHandle, bridge } = get();
    if (!bridge) return;

    // If we have a file handle, write directly — no dialog.
    if (fileHandle) {
      try {
        const { docMap, blocks, llm, editDocBlob, viewDocBlob } = get();
        const blob = await buildDocsBlob(bridge, docMap, blocks, llm, get().formulaStore, editDocBlob, viewDocBlob, get().formulaBlocksData, get().autoFillStore, get().tableDocs);
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        get().markClean();
        return;
      } catch (e) {
        console.error("[saveDocs] fileHandle write failed, falling back", e);
      }
    }

    // No file handle — if fileName exists, download silently with same name.
    if (fileName && fileName.endsWith(".docs")) {
      const { docMap, blocks, llm, editDocBlob, viewDocBlob } = get();
      const blob = await buildDocsBlob(bridge, docMap, blocks, llm, get().formulaStore, editDocBlob, viewDocBlob, get().formulaBlocksData, get().autoFillStore, get().tableDocs);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      get().markClean();
      return;
    }

    // No fileName or fileName doesn't end with .docs — first save, use Save As.
    await get().saveDocsAs();
  },
  saveDocsAs: async () => {
    const { bridge, docMap, blocks, llm, editDocBlob, viewDocBlob } = get();
    if (!bridge) return;
    const blob = await buildDocsBlob(bridge, docMap, blocks, llm, get().formulaStore, editDocBlob, viewDocBlob, get().formulaBlocksData, get().autoFillStore, get().tableDocs);
    const cleanTitle = docMap.meta.title.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_") || "document";
    const suggestedName = `${cleanTitle}.docs`;

    // Try File System Access API — forces .docs extension.
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await (window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName?: string;
            types: Array<{ description: string; accept: Record<string, string[]> }>;
          }) => Promise<FileSystemFileHandle>;
        }).showSaveFilePicker({
          suggestedName,
          types: [{ description: "DOCS Document", accept: { "application/zip": [".docs"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        const name = handle.name || suggestedName;
        set({ fileName: name, fileHandle: handle, dirty: false });
        const recent = [name, ...get().recentDocs.filter((d) => d !== name)].slice(0, 10);
        set({ recentDocs: recent });
        saveRecentDocs(recent);
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // user cancelled
        console.warn("[saveDocsAs] showSaveFilePicker failed, using download", e);
      }
    }

    // Fallback: regular download with .docs extension.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
    set({ fileName: suggestedName, dirty: false });
    const recent = [suggestedName, ...get().recentDocs.filter((d) => d !== suggestedName)].slice(0, 10);
    set({ recentDocs: recent });
    saveRecentDocs(recent);
  },
  openDocsFile: async (file: File) => {
    const { bridge } = get();
    if (!bridge) return;
    const isZip = await isZipFile(file);
    if (isZip) {
      const { importDocsFile } = await import("@/lib/docs/docs-client");
      const data = await importDocsFile(file);
      if (data.docxBlobBase64) {
        // Store both edit and view DOCX blobs
        const editBlob = data.editDocxBlobBase64 ? base64ToBlob(data.editDocxBlobBase64) : null;
        const viewBlob = data.viewDocxBlobBase64 ? base64ToBlob(data.viewDocxBlobBase64) : null;
        const docxBlob = base64ToBlob(data.docxBlobBase64);

        // Load the edit-mode DOCX (contains text markers that will be restored)
        const loadBlob = editBlob || docxBlob;
        const docxFile = new File([loadBlob], "imported.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        await bridge.loadDocx(docxFile, get().user, "edit");

        // Restore formulaBlock nodes — wait for editor to be ready (polling).
        const savedBlocksData = data.formulaBlocksData || [];
        const tryRestore = (attempt: number) => {
          const ed = (bridge as unknown as { getActiveEditor?: () => { getJSON?: () => unknown } | null })?.getActiveEditor?.();
          if (ed) {
            if (savedBlocksData.length > 0) {
              const count = bridge.restoreFormulaBlocksFromData(savedBlocksData);
              if (count > 0) {
                console.log("[openDocsFile] restored", count, "formula blocks from saved data");
                return;
              }
            }
            const count = bridge.restoreFormulaBlocksFromMarkers();
            if (count > 0) {
              console.log("[openDocsFile] restored", count, "formula blocks from markers");
              return;
            }
            if (attempt < 5) {
              setTimeout(() => tryRestore(attempt + 1), 300 + attempt * 200);
            } else {
              console.warn("[openDocsFile] formula restore failed after 5 attempts");
            }
          } else if (attempt < 5) {
            setTimeout(() => tryRestore(attempt + 1), 300 + attempt * 200);
          } else {
            console.warn("[openDocsFile] editor never became ready for formula restore");
          }
        };
        setTimeout(() => tryRestore(0), 200);

        // Restore formulaStore from map if present, or create a new one.
        const importedMap = data.map as DocumentMap | null;
        const importedFormulaStore = (importedMap as unknown as { formulaStore?: FormulaStore })?.formulaStore || null;
        // NEVER set formulaStore to null — always have a valid store so the
        // calculator is always visible in the Resources panel.
        const formulaStore = importedFormulaStore || createEmptyFormulaStore();
        // Restore auto-fill store if present, or reset to empty.
        // Normalize old 1:1 mappings (string values) to new list format (arrays).
        const rawAutoFill = (data as { autoFillStore?: AutoFillStore | null }).autoFillStore || null;
        const importedAutoFillStore: AutoFillStore | null = rawAutoFill
          ? {
              ...rawAutoFill,
              fields: rawAutoFill.fields.map((f) => ({
                ...f,
                instances: f.instances && f.instances.length > 0
                  ? f.instances
                  : [{ suffix: "", selectedValue: f.selectedValue }],
              })),
              syncGroups: rawAutoFill.syncGroups.map((g) => ({
                ...g,
                mappings: normalizeMappings(
                  g.mappings as unknown as Record<string, Record<string, unknown>>,
                ),
              })),
              activeInstance: rawAutoFill.activeInstance || {},
            }
          : null;
        set({
          fileName: file.name,
          fileHandle: null,
          dirty: false,
          formulaStore,
          autoFillStore: importedAutoFillStore || createEmptyAutoFillStore(),
          tableDocs: (data as { tableDocs?: TableDoc[] }).tableDocs || [],
          editDocBlob: editBlob,
          viewDocBlob: viewBlob,
          formulaBlocksData: savedBlocksData,
        });
        if (formulaStore) set({ calcModeActive: true });
        const recent = [file.name, ...get().recentDocs.filter((d) => d !== file.name)].slice(0, 10);
        set({ recentDocs: recent });
        saveRecentDocs(recent);
      }
    } else {
      await bridge.loadDocx(file, get().user, "edit");
      // Keep formulaStore alive — reset to empty (with pi, e constants)
      set({ fileName: null, fileHandle: null, dirty: false, formulaStore: createEmptyFormulaStore(), calcModeActive: false, editDocBlob: null, viewDocBlob: null, formulaBlocksData: [], autoFillStore: createEmptyAutoFillStore(), tableDocs: [] });
    }
  },
}));

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = reader.result as string;
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Build the .docs zip Blob from current document state.
 *  Saves two DOCX versions:
 *    - edit.docx: text markers ({{AF###}} preserved) — for the editor parser.
 *    - view.docx: AutoFill markers replaced with selected values — for viewing/printing.
 */
async function buildDocsBlob(
  bridge: SuperDocBridge,
  docMap: DocumentMap,
  blocks: Block[],
  llm: LlmSettings,
  formulaStore: FormulaStore | null,
  editDocBlob: Blob | null,
  _viewDocBlob: Blob | null,
  formulaBlocksData?: unknown[],
  autoFillStore?: AutoFillStore,
  tableDocs?: TableDoc[],
): Promise<Blob> {
  // IMPORTANT: Collect formulaBlock data BEFORE exportDocx, because exportDocx
  // temporarily replaces formulaBlock nodes with text markers (and restores them).
  const blocksData = formulaBlocksData?.length ? formulaBlocksData : bridge.collectFormulaBlockData();
  // Export edit-mode DOCX (with text markers, then restored) — keeps {{AF###}} markers.
  const editBlob = editDocBlob || await bridge.exportDocx();
  // Generate view.docx by substituting {{AF###}} markers with selected values.
  // If no AutoFill store or no selected values, view.docx = edit.docx (no change).
  const viewBlob = autoFillStore && autoFillStore.fields.some((f) => f.selectedValue)
    ? await substituteAutoFillInDocx(editBlob, autoFillStore)
    : editBlob;
  const docxBlobBase64 = await blobToBase64(editBlob);
  const editDocxBlobBase64 = await blobToBase64(editBlob);
  const viewDocxBlobBase64 = await blobToBase64(viewBlob);
  const embeddings: Record<string, number[]> = {};
  for (const b of blocks) if (b.embedding) embeddings[b.id] = b.embedding;
  const mapData = { ...docMap, blocks, formulaStore: formulaStore || undefined };
  const { exportDocsBlob } = await import("@/lib/docs/docs-client");
  return exportDocsBlob({
    docxBlobBase64,
    editDocxBlobBase64,
    viewDocxBlobBase64,
    map: mapData,
    formulaBlocksData: blocksData,
    autoFillStore: autoFillStore && autoFillStore.fields.length > 0 ? autoFillStore : undefined,
    tableDocs: tableDocs && tableDocs.length > 0 ? tableDocs : undefined,
    embeddings,
    scripts: {},
    meta: { llmModel: llm.chatModel, embeddingModel: llm.embeddingModel },
  });
}

function base64ToBlob(b64: string): Blob {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

async function isZipFile(file: File): Promise<boolean> {
  const buf = await file.slice(0, 4).arrayBuffer();
  const bytes = new Uint8Array(buf);
  return bytes[0] === 0x50 && bytes[1] === 0x4B;
}

/** Format a number for display in the document. */
function formatValue(val: number): string {
  if (isNaN(val)) return "?";
  return val.toLocaleString("ru-RU", { maximumFractionDigits: 10 });
}
