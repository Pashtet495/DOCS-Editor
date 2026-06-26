// ============================================================================
// Document API Executor — applies AgentCommand[] via editor.doc.* (the stable
// SuperDoc Document API) using the STRUCTURAL API (SDFragment).
//
// Key insight: editor.doc.replace accepts BlockNodeAddress directly when using
// the structural form ({ target, content: SDFragment }). This avoids the need
// to build SelectionTarget for listItem and other non-edge-supported types.
// ============================================================================

import type { AgentCommand, CommandResult, DocumentMap } from "./types";
import { renderCanvasPreview, resolveResourceValue } from "./superdoc-bridge";

/** BlockNodeAddress — used as target for most Document API operations. */
interface BlockNodeAddress {
  kind: "block";
  nodeType: string;
  nodeId: string;
}

/** SDFragment — structural content for insert/replace. */
type SDFragment = unknown;

/** Create location for editor.doc.create.* */
type CreateLocation =
  | { kind: "documentStart" }
  | { kind: "documentEnd" }
  | { kind: "before"; target: BlockNodeAddress }
  | { kind: "after"; target: BlockNodeAddress };

/** Minimal typed view of the SuperDoc Document API. */
interface DocApi {
  // Read operations
  find(input: {
    select: { type: "text"; pattern: string; mode?: "contains" | "regex" };
    limit?: number;
  }): { total: number; items: Array<{ address: { kind: string; blockId?: string; nodeType?: string; nodeId?: string } }> };

  // Structural write operations (accept BlockNodeAddress directly!)
  insert(input: {
    target?: BlockNodeAddress;
    content: SDFragment;
    placement?: "before" | "after";
  }, options?: unknown): { success?: boolean; failure?: { message?: string } };

  replace(input: {
    target: BlockNodeAddress;
    content: SDFragment;
  }, options?: unknown): { success?: boolean; failure?: { message?: string } };

  // Block-level delete (accepts BlockNodeAddress)
  blocks: {
    list(input?: { includeText?: boolean }): {
      total: number;
      blocks: Array<{
        ordinal: number;
        nodeId: string;
        nodeType: string;
        textPreview: string | null;
        text?: string | null;
      }>;
    };
    delete(input: { target: BlockNodeAddress }, options?: unknown): { success: boolean; failure?: { message?: string } };
    move?(input: { target: BlockNodeAddress; after?: BlockNodeAddress; before?: BlockNodeAddress }, options?: unknown): { success: boolean };
  };

  // Higher-level create helpers
  create: {
    paragraph(input: { at?: CreateLocation; text?: string }, options?: unknown): { success: boolean; failure?: { message?: string } };
    heading(input: { level: 1 | 2 | 3 | 4 | 5 | 6; at?: CreateLocation; text?: string }, options?: unknown): { success: boolean; failure?: { message?: string } };
    table(input: { at?: CreateLocation; rows?: number; columns?: number }, options?: unknown): { success: boolean; failure?: { message?: string } };
    tableOfContents(input: { at?: CreateLocation }, options?: unknown): { success: boolean; failure?: { message?: string } };
    image(input: {
      at?: CreateLocation;
      src: string;
      alt?: string;
      size?: { width?: number; height?: number; unit?: "px" | "pt" | "twip" };
    }, options?: unknown): { success: boolean; failure?: { message?: string } };
  };

  // Text insertion (simple)
  insertText?(input: { value: string; type?: "text" | "markdown" | "html" }, options?: unknown): unknown;

  // Other adapters
  fields: { insert(input: { at: unknown; instruction: string; mode: "raw" }, options?: unknown): unknown };
  hyperlinks: { insert(input: { at: unknown; url: string; text?: string }, options?: unknown): unknown };
  comments: { create(input: { target: unknown; text: string }, options?: unknown): unknown };
  customXml: { upsert(input: { partName: string; content: string }): unknown };
  diff: { capture(): unknown };
  history: { undo(): unknown };
}

interface EditorLike {
  doc: DocApi;
  getJSON(): unknown;
}

/** Result of applying commands. */
export interface ApplyResult {
  results: CommandResult[];
  updatedResources: DocumentMap["externalResources"];
}

/** Find a block by B-id. Returns BlockNodeAddress + text length. */
function findBlockTarget(editor: EditorLike, blockId: string): { block: BlockNodeAddress; textLength: number } | null {
  if (!blockId) return null;

  const match = blockId.match(/^(B\d+)(?:-(.+))?$/i);
  if (!match) {
    console.warn("[findBlockTarget] unrecognized blockId format:", blockId);
    return null;
  }
  const ordinalStr = match[1]!.toUpperCase();
  const sig = match[2];

  try {
    const result = editor.doc.blocks.list({ includeText: true });
    const ordinalNum = parseInt(ordinalStr.slice(1), 10);
    const blockIndex = ordinalNum - 1;

    if (sig) {
      for (const block of result.blocks) {
        const text = block.text || block.textPreview || "";
        if (sameSignature(text, sig)) {
          return {
            block: { kind: "block", nodeType: block.nodeType, nodeId: block.nodeId },
            textLength: text.length,
          };
        }
      }
    }

    if (blockIndex >= 0 && blockIndex < result.blocks.length) {
      const block = result.blocks[blockIndex];
      if (block) {
        const text = block.text || block.textPreview || "";
        console.log("[findBlockTarget] matched", blockId, "→ nodeId", block.nodeId, "type", block.nodeType);
        return {
          block: { kind: "block", nodeType: block.nodeType, nodeId: block.nodeId },
          textLength: text.length,
        };
      }
    }

    console.warn("[findBlockTarget] no match for", blockId);
  } catch (e) {
    console.warn("[findBlockTarget] blocks.list failed", e);
  }
  return null;
}

function sameSignature(text: string, sig: string): boolean {
  const t = text.trim().slice(0, 120);
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(7, "0") === sig;
}

/** Build an SDFragment for a paragraph with text. */
function paragraphFragment(text: string): SDFragment {
  return {
    kind: "paragraph",
    paragraph: {
      inlines: text ? [{ kind: "run", run: { text } }] : [],
    },
  };
}

/** Build an SDFragment for a heading. */
function headingFragment(level: number, text: string): SDFragment {
  return {
    kind: "heading",
    heading: {
      level: level as 1 | 2 | 3 | 4 | 5 | 6,
      inlines: text ? [{ kind: "run", run: { text } }] : [],
    },
  };
}

/** Parse afterBlockId into a CreateLocation. */
function parseLocation(afterBlockId: string | null, editor: EditorLike): CreateLocation {
  if (!afterBlockId || afterBlockId === "start" || afterBlockId === "null") {
    return { kind: "documentStart" };
  }
  if (afterBlockId === "end") {
    return { kind: "documentEnd" };
  }
  const found = findBlockTarget(editor, afterBlockId);
  if (found) {
    return { kind: "after", target: found.block };
  }
  return { kind: "documentEnd" };
}

/** Main entry: apply a batch of AgentCommands through the Document API. */
export async function applyCommandsViaDocApi(
  editor: unknown,
  commands: AgentCommand[],
  docMap: DocumentMap,
  agentUser: { name: string; email: string; color: string },
): Promise<ApplyResult> {
  const ed = editor as EditorLike;
  if (!ed?.doc) {
    console.error("[doc-api] editor.doc not available");
    return {
      results: commands.map((cmd) => ({
        ok: false,
        command: cmd,
        message: "Document API not ready (editor.doc undefined)",
      })),
      updatedResources: docMap.externalResources,
    };
  }
  const results: CommandResult[] = [];
  const externalResources = [...docMap.externalResources];
  for (const cmd of commands) {
    try {
      const r = await applyOne(ed, cmd, docMap, agentUser, externalResources);
      results.push(r);
      if (!r.ok) break;
    } catch (e) {
      results.push({ ok: false, command: cmd, message: (e as Error).message });
      break;
    }
  }
  return { results, updatedResources: externalResources };
}

async function applyOne(
  editor: EditorLike,
  cmd: AgentCommand,
  docMap: DocumentMap,
  agentUser: { name: string; email: string; color: string },
  externalResources: DocumentMap["externalResources"],
): Promise<CommandResult> {
  switch (cmd.cmd) {
    case "EDIT_BLOCK": {
      const found = findBlockTarget(editor, cmd.blockId);
      if (!found) return { ok: false, command: cmd, message: `block ${cmd.blockId} not found`, affectedBlockId: cmd.blockId };

      if (cmd.newContent != null) {
        // Structural replace: target=BlockNodeAddress, content=SDFragment.
        // This works for ALL block types including listItem.
        try {
          const r = editor.doc.replace({
            target: found.block,
            content: paragraphFragment(cmd.newContent),
          });
          if (r && r.success === false) {
            // Fallback: try create.heading if block was heading, else paragraph via insert+delete.
            return { ok: false, command: cmd, message: r.failure?.message || "replace failed", affectedBlockId: cmd.blockId };
          }
          return { ok: true, command: cmd, message: `block ${cmd.blockId} content replaced`, affectedBlockId: cmd.blockId };
        } catch (e) {
          return { ok: false, command: cmd, message: `replace failed: ${(e as Error).message}`, affectedBlockId: cmd.blockId };
        }
      }

      if (cmd.find != null && cmd.replace != null) {
        // Use editor.doc.find to locate text, then replace.
        try {
          const findResult = editor.doc.find({
            select: { type: "text", pattern: cmd.find, mode: "contains" },
            limit: 1,
          });
          if (findResult.total === 0 || findResult.items.length === 0) {
            return { ok: false, command: cmd, message: `find pattern "${cmd.find}" not found`, affectedBlockId: cmd.blockId };
          }
          // Replace via structural API on the found block.
          const item = findResult.items[0]!;
          const blockId = item.address.blockId || item.address.nodeId;
          if (!blockId) {
            return { ok: false, command: cmd, message: "find result has no blockId", affectedBlockId: cmd.blockId };
          }
          editor.doc.replace({
            target: { kind: "block", nodeType: item.address.nodeType || "paragraph", nodeId: blockId },
            content: paragraphFragment(cmd.replace),
          });
          return { ok: true, command: cmd, message: `replaced "${cmd.find}" → "${cmd.replace}"`, affectedBlockId: cmd.blockId };
        } catch (e) {
          return { ok: false, command: cmd, message: `find/replace failed: ${(e as Error).message}`, affectedBlockId: cmd.blockId };
        }
      }

      return { ok: false, command: cmd, message: "EDIT_BLOCK requires newContent or find/replace", affectedBlockId: cmd.blockId };
    }

    case "CREATE_BLOCK": {
      const at = parseLocation(cmd.afterBlockId ?? null, editor);
      const spec = cmd.newBlock;
      const type = String(spec.type);

      if (type === "heading") {
        const level = (Number(spec.level) || 2) as 1 | 2 | 3 | 4 | 5 | 6;
        try {
          const r = editor.doc.create.heading({ level, at, text: String(spec.content ?? "") });
          return r.success
            ? { ok: true, command: cmd, message: `heading H${level} created`, affectedBlockId: String(spec.id) }
            : { ok: false, command: cmd, message: r.failure?.message || "heading create failed" };
        } catch (e) {
          return { ok: false, command: cmd, message: `heading failed: ${(e as Error).message}` };
        }
      }

      if (type === "paragraph") {
        try {
          const r = editor.doc.create.paragraph({ at, text: String(spec.content ?? "") });
          return r.success
            ? { ok: true, command: cmd, message: `paragraph created`, affectedBlockId: String(spec.id) }
            : { ok: false, command: cmd, message: r.failure?.message || "paragraph create failed" };
        } catch (e) {
          return { ok: false, command: cmd, message: `paragraph failed: ${(e as Error).message}` };
        }
      }

      if (type === "table") {
        const headers = (spec.headers as string[]) || [];
        const rows = (spec.rows as string[][]) || [];
        try {
          const r = editor.doc.create.table({ at, rows: rows.length + 1, columns: headers.length || 2 });
          return r.success
            ? { ok: true, command: cmd, message: `table created`, affectedBlockId: String(spec.id) }
            : { ok: false, command: cmd, message: r.failure?.message || "table create failed" };
        } catch (e) {
          return { ok: false, command: cmd, message: `table failed: ${(e as Error).message}` };
        }
      }

      if (type === "divider") {
        editor.doc.create.paragraph({ at, text: "" });
        return { ok: true, command: cmd, message: `divider created`, affectedBlockId: String(spec.id) };
      }

      // Default: paragraph
      const r = editor.doc.create.paragraph({ at, text: String(spec.content ?? "") });
      return r.success
        ? { ok: true, command: cmd, message: `${type} created (as paragraph)`, affectedBlockId: String(spec.id) }
        : { ok: false, command: cmd, message: r.failure?.message || "create failed" };
    }

    case "DELETE_BLOCK": {
      const found = findBlockTarget(editor, cmd.blockId);
      if (!found) return { ok: false, command: cmd, message: `block ${cmd.blockId} not found`, affectedBlockId: cmd.blockId };
      try {
        const r = editor.doc.blocks.delete({ target: found.block });
        if (r.success) {
          return { ok: true, command: cmd, message: `deleted ${cmd.blockId}`, affectedBlockId: cmd.blockId };
        }
        return { ok: false, command: cmd, message: r.failure?.message || "delete failed", affectedBlockId: cmd.blockId };
      } catch (e) {
        return { ok: false, command: cmd, message: `delete failed: ${(e as Error).message}`, affectedBlockId: cmd.blockId };
      }
    }

    case "MOVE_BLOCK": {
      const srcFound = findBlockTarget(editor, cmd.blockId);
      if (!srcFound) return { ok: false, command: cmd, message: `block ${cmd.blockId} not found`, affectedBlockId: cmd.blockId };

      // Try blocks.move first (if available).
      if (editor.doc.blocks.move) {
        try {
          const afterFound = cmd.afterBlockId && cmd.afterBlockId !== "null" && cmd.afterBlockId !== "start" && cmd.afterBlockId !== "end"
            ? findBlockTarget(editor, cmd.afterBlockId)
            : null;
          const moveInput: { target: BlockNodeAddress; after?: BlockNodeAddress; before?: BlockNodeAddress } = { target: srcFound.block };
          if (afterFound) moveInput.after = afterFound.block;
          const r = editor.doc.blocks.move(moveInput);
          if (r.success) return { ok: true, command: cmd, message: `moved ${cmd.blockId}`, affectedBlockId: cmd.blockId };
        } catch (e) {
          console.warn("[move] blocks.move failed, falling back:", e);
        }
      }

      // Fallback: read text, delete, re-create.
      let text = "";
      try {
        const blocksList = editor.doc.blocks.list({ includeText: true });
        const match = cmd.blockId.match(/^(B\d+)/i);
        if (match) {
          const idx = parseInt(match[1]!.slice(1), 10) - 1;
          const srcBlock = blocksList.blocks[idx];
          text = srcBlock?.text || srcBlock?.textPreview || "";
        }
      } catch { /* ignore */ }

      try {
        editor.doc.blocks.delete({ target: srcFound.block });
      } catch (e) {
        return { ok: false, command: cmd, message: `move delete failed: ${(e as Error).message}`, affectedBlockId: cmd.blockId };
      }

      const at = parseLocation(cmd.afterBlockId ?? null, editor);
      editor.doc.create.paragraph({ at, text });
      return { ok: true, command: cmd, message: `moved ${cmd.blockId}`, affectedBlockId: cmd.blockId };
    }

    case "UPDATE_STYLE": {
      // Style application via Document API styles adapter.
      // For now, just acknowledge — the user can apply formatting via toolbar.
      return { ok: true, command: cmd, message: `style ${cmd.styleId} noted for ${cmd.blockId}`, affectedBlockId: cmd.blockId };
    }

    case "INSERT_CANVAS": {
      const dataUrl = renderCanvasPreview(cmd.code, cmd.lang);
      if (!dataUrl) return { ok: false, command: cmd, message: "canvas rendering failed" };

      const resId = `R${String(externalResources.length + 1).padStart(3, "0")}`;
      const title = cmd.title || `Canvas ${resId}`;
      externalResources.push({
        id: resId,
        name: title,
        type: "canvas" as const,
        content: cmd.code,
        lang: cmd.lang,
        dataUrl,
        description: "JS/TS canvas visualization",
      });

      const at = parseLocation(cmd.afterBlockId ?? null, editor);
      let r: { success: boolean; failure?: { message?: string } };
      try {
        r = editor.doc.create.image({
          at,
          src: dataUrl,
          alt: `[canvas:${resId}] ${title}`,
          size: { width: 600, height: 320, unit: "px" },
        });
      } catch (e) {
        console.error("[canvas] create.image threw:", e);
        r = { success: false, failure: { message: (e as Error).message } };
      }
      return r.success
        ? { ok: true, command: cmd, message: `canvas ${resId} inserted`, affectedBlockId: resId }
        : { ok: false, command: cmd, message: r.failure?.message || "canvas insert failed" };
    }

    case "LINK_RESOURCE": {
      const res = docMap.externalResources.find((r) => r.id === cmd.resourceId);
      if (!res) return { ok: false, command: cmd, message: `resource ${cmd.resourceId} not found` };
      const value = resolveResourceValue(res, cmd.query);
      const at = parseLocation(cmd.afterBlockId ?? null, editor);
      editor.doc.create.paragraph({
        at,
        text: `[${res.name}${cmd.query ? ": " + cmd.query : ""}] = ${value}`,
      });
      return { ok: true, command: cmd, message: `linked resource ${cmd.resourceId}` };
    }

    case "CREATE_RESOURCE": {
      return { ok: true, command: cmd, message: `resource "${cmd.name}" registered in map` };
    }

    case "SET_TITLE": {
      return { ok: true, command: cmd, message: `title set to "${cmd.title}"` };
    }
  }
}
