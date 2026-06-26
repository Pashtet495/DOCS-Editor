// ============================================================================
// System prompt for the in-editor AI agent.
//
// The agent's job: turn a natural-language instruction about the document into
// a STRICT JSON array of AgentCommand objects. It receives the current block
// map (with ids) + RAG hits so it can address blocks precisely.
// ============================================================================

import type { Block, DocumentMap, RagHit } from "../editor/types";
import { textOfBlock } from "../editor/pmMap";

export function buildSystemPrompt(opts: {
  doc: DocumentMap;
  ragHits: RagHit[];
  blocks: Block[];
}): string {
  const { doc, ragHits, blocks } = opts;

  // For large documents, limit the block index to avoid overflowing the LLM
  // context window. Show first 15 + last 5 blocks, with RAG hits filling the gap.
  const MAX_BLOCKS_IN_PROMPT = 30;
  let blockList = blocks;
  let truncated = false;
  if (blocks.length > MAX_BLOCKS_IN_PROMPT && ragHits.length === 0) {
    // No RAG hits — show first 15 + last 5 + note about middle blocks.
    const first = blocks.slice(0, 15);
    const last = blocks.slice(-5);
    blockList = [...first, ...last];
    truncated = true;
  }

  const blockIndex = blockList
    .map((b) => {
      const originalIndex = blocks.indexOf(b);
      const text = textOfBlock(b).slice(0, 150);
      const head = b.type === "heading" ? ` (H${b.level})` : "";
      const shortId = `B${String(originalIndex + 1).padStart(3, "0")}`;
      return `- ${shortId}${head} [${b.type}]: ${text.replace(/\n/g, " ")}`;
    })
    .join("\n");

  const truncationNote = truncated
    ? `\n(Showing first 15 + last 5 blocks out of ${blocks.length}. Middle blocks omitted — use RAG search to find specific content.)`
    : "";

  const ragSection =
    ragHits.length > 0
      ? "\n\nRelevant blocks retrieved via RAG (semantic search over your instruction):\n" +
        ragHits.map((h) => {
          // Convert full id (B001-abc) to short id (B001) for display.
          const shortId = h.blockId.split("-")[0] || h.blockId;
          return `- ${shortId} (score ${h.score.toFixed(2)}): ${h.snippet.replace(/\n/g, " ")}`;
        }).join("\n")
      : "";

  const resources = doc.externalResources
    .map((r) => `- ${r.id} [${r.type}] ${r.name}: ${r.description || r.content.slice(0, 80)}`)
    .join("\n");

  return `You are an in-document AI editor agent embedded in a WYSIWYG editor powered by superdoc (real DOCX engine).

Your ONLY output is JSON commands. Output a JSON array of command objects. Do NOT wrap in markdown fences. Do NOT add prose or explanation. If no action is needed, return [].

Output format (choose ONE):
  Option A (preferred): A JSON array: [{"cmd":"EDIT_BLOCK",...},{"cmd":"CREATE_BLOCK",...}]
  Option B (accepted): Individual JSON objects, one per line: {"cmd":"EDIT_BLOCK",...}\\n{"cmd":"CREATE_BLOCK",...}

## Current document
Title: "${doc.meta.title}"
Blocks (${blocks.length}):
${blockIndex || "(empty document)"}${truncationNote}${ragSection}

${resources ? "External resources:\n" + resources + "\n" : ""}
## Block IDs
Block IDs in the list above are like "B001", "B002", etc. Use these SHORT IDs (B001, B002, B127) in your commands. Do NOT use the full signature part after the dash.

## Command protocol
Each command is an object with a "cmd" field. Apply exactly these command shapes:

1. EDIT_BLOCK — modify an existing block's text.
   { "cmd": "EDIT_BLOCK", "blockId": "B007", "newContent": "full new text of the block" }
   or find/replace within a block:
   { "cmd": "EDIT_BLOCK", "blockId": "B007", "find": "old phrase", "replace": "new phrase" }
   Optional anchors (validated before applying):
   { ..., "textBefore": "must exist before edit", "textAfter": "must exist after edit" }

2. CREATE_BLOCK — insert a new block.
   afterBlockId controls WHERE to insert:
   - "B007" = insert AFTER block B007
   - null = insert at the BEGINNING of the document
   - "end" = insert at the END of the document
   { "cmd": "CREATE_BLOCK", "afterBlockId": "B007", "newBlock": { "id": "B018", "type": "heading", "level": 2, "content": "Heading text" } }
   newBlock shapes by type:
     heading:        { "id":"B018","type":"heading","level":1|2|3|4|5|6,"content":"..." }
     paragraph:      { "id":"B019","type":"paragraph","content":"..." }
     list:           { "id":"B020","type":"list","ordered":true,"items":["a","b"] }
     quote:          { "id":"B021","type":"quote","content":"..." }
     code:           { "id":"B022","type":"code","lang":"javascript","content":"..." }
     divider:        { "id":"B023","type":"divider" }
     image:          { "id":"B024","type":"image","src":"data:...","alt":"..." }
     table:          { "id":"B025","type":"table","headers":["A","B"],"rows":[["1","2"]] }

3. DELETE_BLOCK — remove a block.
   { "cmd": "DELETE_BLOCK", "blockId": "B007" }

4. MOVE_BLOCK — relocate a block.
   { "cmd": "MOVE_BLOCK", "blockId": "B007", "afterBlockId": "B018" }
   afterBlockId: "B018" = move after B018; null = move to beginning; "end" = move to end.

5. UPDATE_STYLE — apply a style id to a block.
   { "cmd": "UPDATE_STYLE", "blockId": "B007", "styleId": "S01" }

6. INSERT_CANVAS — insert a JS/TS visualization rendered to canvas.
   { "cmd": "INSERT_CANVAS", "afterBlockId": "B007", "lang": "js", "title": "Sales chart", "code": "ctx.fillStyle='#3b82f6'; ctx.fillRect(10,10,100,100);" }
   afterBlockId: same rules as CREATE_BLOCK (null = beginning, "end" = end).
   The code receives (canvas, ctx) and must draw synchronously. Use canvas.width (600) and canvas.height (320).

7. CREATE_RESOURCE — add an external XML/JSON/CSV table for reference.
   { "cmd": "CREATE_RESOURCE", "name": "Q1 Sales", "type": "xml", "content": "<sales><q1>1200</q1></sales>", "description": "..." }

8. LINK_RESOURCE — insert a reference to a resource (resolved value shown inline).
   { "cmd": "LINK_RESOURCE", "afterBlockId": "B007", "resourceId": "R001", "query": "/sales/q1" }

9. SET_TITLE — change the document title.
   { "cmd": "SET_TITLE", "title": "New Title" }

## Rules
- Use SHORT block IDs (B001, B002, B127) from the "Blocks" list above. Never invent ids for EDIT/DELETE/MOVE.
- For CREATE_BLOCK / INSERT_CANVAS / LINK_RESOURCE, choose new ids like B018, B019, B020 (sequentially after the highest existing B-number).
- afterBlockId: null = BEGINNING of document; "end" = END of document; "B007" = after block B007.
- Keep block text faithful to the document's language and tone.
- Prefer multiple small commands over one huge rewrite.
- Return ONLY JSON commands (array or one-per-line). No markdown fences, no prose.
- Example: [{"cmd":"EDIT_BLOCK","blockId":"B003","newContent":"..."},{"cmd":"CREATE_BLOCK","afterBlockId":"B003","newBlock":{"id":"B018","type":"heading","level":2,"content":"First appearance"}}]`;
}

/** Parse the LLM response — format-agnostic.
 *
 * Handles any of these LLM output formats:
 *   1. JSON array: [{"cmd":"EDIT_BLOCK",...},{"cmd":"CREATE_BLOCK",...}]
 *   2. Individual objects (one per line): {"cmd":"EDIT_BLOCK",...}\n{"cmd":"CREATE_BLOCK",...}
 *   3. Markdown-fenced: ```json [...] ``` or ```json {...} ```
 *   4. Objects mixed with prose text
 *   5. Single object: {"cmd":"SET_TITLE",...}
 *
 * Strategy: scan the text for all top-level JSON objects using brace matching,
 * parse each one, and collect those that have a "cmd" field.
 */
export function parseAgentCommands(raw: string): {
  commands: import("./types").AgentCommand[];
  reasoning?: string;
} {
  if (!raw || typeof raw !== "string") {
    console.warn("[parse] empty or non-string response");
    return { commands: [], reasoning: raw };
  }

  console.log("[parse] raw response length:", raw.length, "first 200 chars:", raw.slice(0, 200));

  // Strip ```json ... ``` fences if present (extract content between fences).
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;

  // Strategy 1: try to parse the whole thing as a JSON array.
  const trimmed = candidate.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const cmds = parsed.filter((item) => item && typeof item === "object" && "cmd" in item);
        console.log("[parse] strategy 1 (JSON array): parsed", cmds.length, "commands");
        return { commands: cmds as import("./types").AgentCommand[] };
      }
      if (parsed && typeof parsed === "object" && "cmd" in parsed) {
        console.log("[parse] strategy 1 (single JSON object): parsed 1 command");
        return { commands: [parsed] as import("./types").AgentCommand[] };
      }
    } catch {
      // Not valid JSON as a whole — fall through to strategy 2.
    }
  }

  // Strategy 2: scan for individual JSON objects using brace matching.
  // This handles: one-object-per-line, objects mixed with prose, etc.
  const commands: import("./types").AgentCommand[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const objStr = candidate.slice(start, i + 1);
        try {
          const obj = JSON.parse(objStr);
          if (obj && typeof obj === "object" && "cmd" in obj) {
            commands.push(obj as import("./types").AgentCommand);
          }
        } catch {
          // Skip malformed objects.
          console.warn("[parse] skipped malformed object at pos", start, ":", objStr.slice(0, 80));
        }
        start = -1;
      }
    }
  }

  if (commands.length > 0) {
    console.log("[parse] strategy 2 (brace matching): found", commands.length, "commands");
    return { commands };
  }

  // Strategy 3: try fixing common JSON issues and re-parse as array.
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    const jsonStr = candidate.slice(arrayStart, arrayEnd + 1);
    try {
      const fixed = jsonStr
        .replace(/,\s*]/g, "]")
        .replace(/,\s*}/g, "}");
      const parsed = JSON.parse(fixed);
      if (Array.isArray(parsed)) {
        console.log("[parse] strategy 3 (fixed array): parsed", parsed.length, "commands");
        return { commands: parsed as import("./types").AgentCommand[] };
      }
    } catch {
      // Give up.
    }
  }

  console.warn("[parse] no commands found in response");
  return { commands: [], reasoning: raw };
}
