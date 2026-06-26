// ============================================================================
// ProseMirror ↔ BlockMap converter.
//
// The DocumentMap is a *projection* of superdoc's ProseMirror document. We walk
// the top-level block nodes of `editor.getJSON()` and produce the Block list
// used by RAG + the AI executor. Block ids (B001…) are derived from a stable
// signature so the same logical block keeps its id across re-reads as long as
// its leading text hasn't changed.
// ============================================================================

import type { Block, BlockType, DocumentMap, ExternalResource } from "./types";

// Minimal ProseMirror JSON shape (we don't depend on prosemirror-model types).
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export interface PMJSON {
  type: "doc";
  content?: PMNode[];
}

/** Pull the plain text out of a ProseMirror node subtree. */
export function nodeText(node: PMNode): string {
  if (node.type === "text" && node.text) return node.text;
  if (!node.content) return "";
  return node.content.map(nodeText).join("");
}

/** djb2 string hash → base36, zero-padded. Stable across runs. */
export function hashSignature(text: string): string {
  const t = text.trim().slice(0, 120);
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(7, "0");
}

/** Build a stable B-id from index + leading-text signature. */
export function blockIdFor(index: number, text: string): string {
  return `B${String(index + 1).padStart(3, "0")}-${hashSignature(text)}`;
}

/** Map a ProseMirror node type → our BlockType (or null if not a block). */
function classifyPmNode(node: PMNode): BlockType | null {
  switch (node.type) {
    case "heading":
      return "heading";
    case "paragraph":
      return "paragraph";
    case "bulletList":
    case "orderedList":
      return "list";
    case "blockquote":
      return "quote";
    case "codeBlock":
      return "code";
    case "horizontalRule":
      return "divider";
    case "image":
      return "image";
    case "table":
      return "table";
    default:
      return null;
  }
}

const TOP_LEVEL_BLOCKS = new Set([
  "heading",
  "paragraph",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "image",
  "table",
]);

/** Convert ProseMirror JSON into the Block list (without embeddings). */
export function pmToBlocks(json: PMJSON, prevBlocks: Block[] = []): Block[] {
  const out: Block[] = [];
  const top = (json.content ?? []).filter((n) => TOP_LEVEL_BLOCKS.has(n.type));
  // Index lookup for embedding reuse keyed by old id.
  const prevById = new Map(prevBlocks.map((b) => [b.id, b]));
  const prevBySig = new Map(prevBlocks.map((b) => [signatureOf(b), b]));

  top.forEach((node, i) => {
    const text = nodeText(node);
    const id = blockIdFor(i, text);
    const sig = hashSignature(text);
    // Reuse embedding if a previous block had the same signature.
    const reuse = prevBySig.get(sig);
    const embedding = reuse?.embedding;
    const embeddingModel = reuse?.embeddingModel;
    const base = { id, embedding, embeddingModel };

    switch (node.type) {
      case "heading": {
        const level = ((node.attrs?.level as number) || 1) as 1 | 2 | 3 | 4 | 5 | 6;
        out.push({ ...base, type: "heading", level, content: text });
        break;
      }
      case "paragraph": {
        out.push({ ...base, type: "paragraph", content: text });
        break;
      }
      case "bulletList":
      case "orderedList": {
        const items = (node.content ?? []).map((li) =>
          (li.content ?? []).map(nodeText).join("").trim(),
        );
        out.push({ ...base, type: "list", ordered: node.type === "orderedList", items });
        break;
      }
      case "blockquote": {
        out.push({ ...base, type: "quote", content: text });
        break;
      }
      case "codeBlock": {
        out.push({
          ...base,
          type: "code",
          lang: (node.attrs?.language as string) || "text",
          content: text,
        });
        break;
      }
      case "horizontalRule": {
        out.push({ ...base, type: "divider" });
        break;
      }
      case "image": {
        out.push({
          ...base,
          type: "image",
          src: (node.attrs?.src as string) || "",
          alt: (node.attrs?.alt as string) || undefined,
        });
        break;
      }
      case "table": {
        const rows = (node.content ?? []).filter((r) => r.type === "tableRow");
        const matrix = rows.map((r) =>
          (r.content ?? []).map((c) => nodeText(c).trim()),
        );
        const headers = matrix[0] ?? [];
        const body = matrix.slice(1);
        out.push({
          ...base,
          type: "table",
          headers,
          rows: body,
          sourceRef: (node.attrs?.sourceRef as string) || undefined,
        });
        break;
      }
    }
    void prevById;
  });
  return out;
}

function signatureOf(b: Block): string {
  return hashSignature(textOfBlock(b));
}

/** Plain-text view of a block — used for embeddings + RAG snippets. */
export function textOfBlock(b: Block): string {
  switch (b.type) {
    case "heading":
    case "paragraph":
    case "quote":
    case "code":
      return b.content;
    case "list":
      return b.items.join("\n");
    case "table":
      return [b.headers.join(" | "), ...b.rows.map((r) => r.join(" | "))].join("\n");
    case "image":
      return b.alt || "[image]";
    case "divider":
      return "—";
    case "canvas":
      return `${b.title || ""}\n${b.code}`;
    case "external-ref":
      return `[ref:${b.resourceId}${b.query ? " " + b.query : ""}]`;
  }
}

/** Build a Block object (used by executor when creating blocks from AI spec). */
export function makeBlock(spec: {
  type: BlockType;
  content?: string;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  items?: string[];
  ordered?: boolean;
  lang?: string;
  src?: string;
  alt?: string;
  headers?: string[];
  rows?: string[][];
  sourceRef?: string;
  code?: string;
  title?: string;
  resourceId?: string;
  query?: string;
}): Block {
  const idx = Math.floor(Math.random() * 1e6);
  const text =
    spec.content ?? spec.items?.join("\n") ?? spec.code ?? spec.headers?.join(" ") ?? "";
  const id = blockIdFor(idx, text + Date.now());
  const base = { id };
  switch (spec.type) {
    case "heading":
      return { ...base, type: "heading", level: spec.level || 2, content: spec.content || "" };
    case "paragraph":
      return { ...base, type: "paragraph", content: spec.content || "" };
    case "list":
      return { ...base, type: "list", ordered: !!spec.ordered, items: spec.items || [] };
    case "quote":
      return { ...base, type: "quote", content: spec.content || "" };
    case "code":
      return { ...base, type: "code", lang: spec.lang || "text", content: spec.content || "" };
    case "divider":
      return { ...base, type: "divider" };
    case "image":
      return { ...base, type: "image", src: spec.src || "", alt: spec.alt };
    case "table":
      return {
        ...base,
        type: "table",
        headers: spec.headers || [],
        rows: spec.rows || [],
        sourceRef: spec.sourceRef,
      };
    case "canvas":
      return { ...base, type: "canvas", lang: spec.lang || "js", code: spec.code || "", title: spec.title };
    case "external-ref":
      return { ...base, type: "external-ref", resourceId: spec.resourceId || "", query: spec.query };
  }
}

/** Convert one of our Blocks → a ProseMirror JSON node for insertion. */
export function blockToPmNode(b: Block): PMNode {
  switch (b.type) {
    case "heading":
      return { type: "heading", attrs: { level: b.level }, content: [{ type: "text", text: b.content }] };
    case "paragraph":
      return { type: "paragraph", content: b.content ? [{ type: "text", text: b.content }] : [] };
    case "list":
      return {
        type: b.ordered ? "orderedList" : "bulletList",
        content: b.items.map((it) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: it }] }],
        })),
      };
    case "quote":
      return { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: b.content }] }] };
    case "code":
      return { type: "codeBlock", attrs: { language: b.lang }, content: [{ type: "text", text: b.content }] };
    case "divider":
      return { type: "horizontalRule" };
    case "image":
      return { type: "image", attrs: { src: b.src, alt: b.alt || "" } };
    case "table": {
      const headerRow = {
        type: "tableRow",
        content: b.headers.map((h) => ({
          type: "tableHeader",
          content: [{ type: "paragraph", content: [{ type: "text", text: h }] }],
        })),
      };
      const bodyRows = b.rows.map((r) => ({
        type: "tableRow",
        content: r.map((c) => ({
          type: "tableCell",
          content: [{ type: "paragraph", content: [{ type: "text", text: c }] }],
        })),
      }));
      return { type: "table", content: [headerRow, ...bodyRows] };
    }
    case "canvas":
      // Canvas rendered as image: src is a data URL produced by canvasRuntime.
      return { type: "image", attrs: { src: b.meta?.dataUrl as string || "", alt: `[canvas:${b.title || "untitled"}]` } };
    case "external-ref":
      return {
        type: "paragraph",
        content: [{ type: "text", text: `[${b.resourceId}${b.query ? ":" + b.query : ""}]` }],
      };
  }
}

export function emptyDocumentMap(title = "Untitled Document"): DocumentMap {
  const now = new Date().toISOString();
  return {
    meta: {
      id: `D-${Date.now().toString(36)}`,
      title,
      version: "1.0.0",
      createdAt: now,
      updatedAt: now,
      pageSize: { width: 794, height: 1123 },
      margin: 96,
    },
    styles: [
      { id: "S01", name: "Body", appliesTo: "paragraph", size: 11, lineHeight: 1.5 },
      { id: "S02", name: "Heading 1", appliesTo: "heading", level: undefined as never, size: 24, bold: true },
      { id: "S03", name: "Heading 2", appliesTo: "heading", size: 18, bold: true },
    ] as DocumentMap["styles"],
    blocks: [],
    externalResources: [] as ExternalResource[],
  };
}
