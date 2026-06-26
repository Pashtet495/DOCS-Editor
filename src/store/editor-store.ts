"use client";

import { create } from "zustand";
import type {
  AgentCommand,
  Block,
  ChatMessage,
  CommandResult,
  DocumentMap,
  LlmSettings,
  ModelOption,
  RagHit,
} from "@/lib/editor/types";
import { DEFAULT_LLM } from "@/lib/editor/types";
import { emptyDocumentMap, type PMJSON } from "@/lib/editor/pmMap";
import { reindexBlocks, ragSearch } from "@/lib/ai/rag";
import { buildSystemPrompt, parseAgentCommands } from "@/lib/ai/system-prompt";
import { applyCommandsViaDocApi } from "@/lib/editor/doc-api-executor";
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

  // actions
  onBlocksUpdated: (blocks: Block[]) => void;
  setTotalPages: (n: number) => void;
  setReady: (r: boolean) => void;
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

  fileName: null,
  fileHandle: null,
  dirty: false,
  recentDocs: loadRecentDocs(),

  onBlocksUpdated: (blocks) =>
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
    }),

  setTotalPages: (n) => set({ totalPages: n }),
  setReady: (r) => set({ ready: r }),
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
      const res = await fetch("/api/llm/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: llm.baseUrl, apiKey: llm.apiKey }),
      });
      const data = await res.json();
      const models = data.models || [];
      set({ models, modelsLoading: false, modelsError: data.error || null });
      if (models.length) {
        const chat = models.find((m: ModelOption) => /embed/i.test(m.id)) ? models.find((m: ModelOption) => !/embed/i.test(m.id)) : models[0];
        const embed = models.find((m: ModelOption) => /embed/i.test(m.id)) || models[0];
        // Use setLlm to persist to localStorage.
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
      const res = await fetch("/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.chatModel, messages, temperature: 0.2 }),
      });
      const data = await res.json();
      const content = data.content || "";
      console.log("[agent] LLM response:", { length: content.length, first200: content.slice(0, 200), error: data.error });
      if (data.error) {
        set({
          chat: [
            ...get().chat,
            { id: nextId(), role: "assistant", content: `⚠️ Ошибка LLM: ${data.error}`, ts: Date.now() },
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
    const { superdoc, docMap, blocks, llm } = get();
    if (!superdoc) return;
    const docxBlob = await (superdoc as { export: (o: Record<string, unknown>) => Promise<Blob> }).export({ exportType: "docx", triggerDownload: false });
    const docxBlobBase64 = await blobToBase64(docxBlob);
    const embeddings: Record<string, number[]> = {};
    for (const b of blocks) if (b.embedding) embeddings[b.id] = b.embedding;
    const res = await fetch("/api/docs/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docxBlobBase64,
        map: { ...docMap, blocks },
        embeddings,
        scripts: {},
        meta: { llmModel: llm.chatModel, embeddingModel: llm.embeddingModel },
      }),
    });
    const blob = await res.blob();
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
    const { fileName, fileHandle, superdoc, docMap, blocks, llm } = get();
    if (!superdoc) return;

    // If we have a file handle (from previous Save As), write directly — no dialog.
    if (fileHandle) {
      try {
        const blob = await buildDocsBlob(superdoc, docMap, blocks, llm);
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        get().markClean();
        return;
      } catch (e) {
        console.error("[saveDocs] fileHandle write failed, falling back to download", e);
      }
    }

    // No file handle — if fileName exists, download silently with same name.
    if (fileName) {
      await get().exportDocs(fileName);
      get().markClean();
      return;
    }

    // No fileName — first save, use Save As.
    await get().saveDocsAs();
  },
  saveDocsAs: async () => {
    const { superdoc, docMap, blocks, llm } = get();
    if (!superdoc) return;
    const blob = await buildDocsBlob(superdoc, docMap, blocks, llm);
    // Strip any existing extension from title, then add .docs.
    const cleanTitle = docMap.meta.title.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_") || "document";
    const suggestedName = `${cleanTitle}.docs`;

    // Try File System Access API (Chrome/Edge/Electron) — shows save dialog once.
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
        // User cancelled or API not available — fall back to download.
        console.warn("[saveDocsAs] showSaveFilePicker failed, using download", e);
      }
    }

    // Fallback: regular download.
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
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/docs/import", { method: "POST", body: formData });
      const data = await res.json();
      if (data.docxBlobBase64) {
        const docxBlob = base64ToBlob(data.docxBlobBase64);
        const docxFile = new File([docxBlob], "imported.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        await bridge.loadDocx(docxFile, get().user);
        set({ fileName: file.name, fileHandle: null, dirty: false });
        const recent = [file.name, ...get().recentDocs.filter((d) => d !== file.name)].slice(0, 10);
        set({ recentDocs: recent });
        saveRecentDocs(recent);
      }
    } else {
      await bridge.loadDocx(file, get().user);
      set({ fileName: null, fileHandle: null, dirty: false });
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

/** Build the .docs zip Blob from current document state. */
async function buildDocsBlob(
  superdoc: unknown,
  docMap: DocumentMap,
  blocks: Block[],
  llm: LlmSettings,
): Promise<Blob> {
  const docxBlob = await (superdoc as { export: (o: Record<string, unknown>) => Promise<Blob> }).export({ exportType: "docx", triggerDownload: false });
  const docxBlobBase64 = await blobToBase64(docxBlob);
  const embeddings: Record<string, number[]> = {};
  for (const b of blocks) if (b.embedding) embeddings[b.id] = b.embedding;
  const res = await fetch("/api/docs/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      docxBlobBase64,
      map: { ...docMap, blocks },
      embeddings,
      scripts: {},
      meta: { llmModel: llm.chatModel, embeddingModel: llm.embeddingModel },
    }),
  });
  return res.blob();
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
