// ============================================================================
// Client-side .docs export/import — replaces the Next.js API routes.
// Uses JSZip directly in the browser. No server needed.
// ============================================================================

import JSZip from "jszip";
import type { DocumentMap } from "@/lib/editor/types";
import type { AutoFillStore } from "@/lib/editor/autofill-types";
import type { TableDoc } from "@/lib/table/types";

const RESOURCE_EXT: Record<string, string> = {
  xml: "xml",
  json: "json",
  csv: "csv",
  canvas: "js",
};

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "script";
}

/** Base64 → Uint8Array (browser-compatible, no Buffer) */
function base64ToUint8Array(b64: string): Uint8Array {
  const binStr = atob(b64);
  const arr = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    arr[i] = binStr.charCodeAt(i);
  }
  return arr;
}

/** Uint8Array → Base64 (browser-compatible, no Buffer) */
function uint8ArrayToBase64(arr: Uint8Array): string {
  let binStr = "";
  for (let i = 0; i < arr.length; i++) {
    binStr += String.fromCharCode(arr[i]);
  }
  return btoa(binStr);
}

// ---------------------------------------------------------------------------
// Export — build .docs zip from parts, return as Blob
// ---------------------------------------------------------------------------

export interface DocsExportInput {
  docxBlobBase64: string;
  editDocxBlobBase64?: string;
  viewDocxBlobBase64?: string;
  map?: DocumentMap;
  formulaBlocksData?: unknown[];
  autoFillStore?: AutoFillStore;
  tableDocs?: TableDoc[];
  embeddings?: Record<string, number[]>;
  scripts?: Record<string, string>;
  meta?: Record<string, unknown>;
}

export async function exportDocsBlob(input: DocsExportInput): Promise<Blob> {
  const {
    docxBlobBase64, editDocxBlobBase64, viewDocxBlobBase64, map,
    formulaBlocksData, autoFillStore, tableDocs,
    embeddings = {}, scripts = {}, meta = {},
  } = input;

  if (!docxBlobBase64) throw new Error("docxBlobBase64 is required");

  const zip = new JSZip();

  zip.file("document.docx", base64ToUint8Array(docxBlobBase64));
  if (editDocxBlobBase64) zip.file("edit.docx", base64ToUint8Array(editDocxBlobBase64));
  if (viewDocxBlobBase64) zip.file("view.docx", base64ToUint8Array(viewDocxBlobBase64));

  if (map) {
    let finalMap = map;
    if (Object.keys(embeddings).length > 0) {
      const mergedBlocks = (map.blocks ?? []).map((b) => {
        if (b.embedding) return b;
        const emb = embeddings[b.id];
        return emb ? { ...b, embedding: emb } : b;
      });
      finalMap = { ...map, blocks: mergedBlocks };
    }
    zip.file("map.json", JSON.stringify(finalMap, null, 2));
  }

  if (map?.formulaStore) zip.file("formulas.json", JSON.stringify(map.formulaStore, null, 2));
  if (formulaBlocksData && Array.isArray(formulaBlocksData) && formulaBlocksData.length > 0)
    zip.file("formula-blocks.json", JSON.stringify(formulaBlocksData, null, 2));
  if (autoFillStore && autoFillStore.fields && autoFillStore.fields.length > 0)
    zip.file("autofill.json", JSON.stringify(autoFillStore, null, 2));

  if (tableDocs && Array.isArray(tableDocs) && tableDocs.length > 0) {
    for (const doc of tableDocs) {
      const safeName = (doc.name || doc.id).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
      zip.file(`tables/${doc.id}_${safeName}.json`, JSON.stringify(doc, null, 2));
    }
  }

  zip.file("meta.json", JSON.stringify(
    { format: "DOCS", version: "1.0.0", createdAt: new Date().toISOString(), ...meta },
    null, 2,
  ));

  if (map?.externalResources) {
    for (const r of map.externalResources) {
      const ext = RESOURCE_EXT[r.type] ?? "txt";
      const content = r.type === "canvas" ? r.content : (r.content ?? "");
      zip.file(`externals/${r.id}.${ext}`, content);
    }
  }

  const scriptIndex: Record<string, string> = {};
  for (const [key, code] of Object.entries(scripts)) {
    let filename = sanitizeFilename(key);
    if (!/\.(js|ts)$/.test(filename)) filename += ".js";
    zip.file(`scripts/${filename}`, code ?? "");
    scriptIndex[filename] = key;
  }
  if (Object.keys(scriptIndex).length > 0)
    zip.file("scripts/index.json", JSON.stringify(scriptIndex, null, 2));

  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

// ---------------------------------------------------------------------------
// Import — read .docs zip from File, return parsed parts
// ---------------------------------------------------------------------------

export interface DocsImportResult {
  map: DocumentMap | null;
  embeddings: Record<string, number[]>;
  docxBlobBase64: string;
  editDocxBlobBase64: string;
  viewDocxBlobBase64: string;
  formulaBlocksData: unknown[];
  autoFillStore: AutoFillStore | null;
  tableDocs: TableDoc[];
  scripts: Record<string, string>;
  externals: Record<string, string>;
  meta: Record<string, unknown>;
}

function emptyImportResult(docxBlobBase64 = ""): DocsImportResult {
  return {
    map: null, embeddings: {}, docxBlobBase64,
    editDocxBlobBase64: docxBlobBase64, viewDocxBlobBase64: docxBlobBase64,
    formulaBlocksData: [], autoFillStore: null, tableDocs: [],
    scripts: {}, externals: {}, meta: {},
  };
}

function isZipBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

export async function importDocsFile(file: File): Promise<DocsImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const looksLikeDocx = file.name.toLowerCase().endsWith(".docx") || !isZipBytes(bytes);
  if (looksLikeDocx) return emptyImportResult(uint8ArrayToBase64(bytes));

  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { return emptyImportResult(uint8ArrayToBase64(bytes)); }

  const result: DocsImportResult = emptyImportResult();

  const docxFile = zip.file("document.docx");
  if (docxFile) {
    const docxBytes = await docxFile.async("uint8array");
    result.docxBlobBase64 = uint8ArrayToBase64(docxBytes);
    result.editDocxBlobBase64 = result.docxBlobBase64;
    result.viewDocxBlobBase64 = result.docxBlobBase64;
  }

  const editDocxFile = zip.file("edit.docx");
  if (editDocxFile) result.editDocxBlobBase64 = uint8ArrayToBase64(await editDocxFile.async("uint8array"));

  const viewDocxFile = zip.file("view.docx");
  if (viewDocxFile) result.viewDocxBlobBase64 = uint8ArrayToBase64(await viewDocxFile.async("uint8array"));

  const formulaBlocksFile = zip.file("formula-blocks.json");
  if (formulaBlocksFile) {
    try { const p = JSON.parse(await formulaBlocksFile.async("string")); if (Array.isArray(p)) result.formulaBlocksData = p; }
    catch { result.formulaBlocksData = []; }
  }

  const autoFillFile = zip.file("autofill.json");
  if (autoFillFile) {
    try { const p = JSON.parse(await autoFillFile.async("string")); if (p?.fields) result.autoFillStore = p as AutoFillStore; }
    catch { result.autoFillStore = null; }
  }

  result.tableDocs = [];
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith("tables/") || path.endsWith("/")) continue;
    const entry = zip.files[path]; if (entry.dir) continue;
    try { const p = JSON.parse(await entry.async("string")); if (p?.id && p.cells !== undefined) result.tableDocs.push(p as TableDoc); }
    catch { /* skip */ }
  }

  const mapFile = zip.file("map.json");
  if (mapFile) { try { result.map = JSON.parse(await mapFile.async("string")) as DocumentMap; } catch { result.map = null; } }

  const embFile = zip.file("embeddings.json");
  if (embFile) { try { result.embeddings = JSON.parse(await embFile.async("string")); } catch { result.embeddings = {}; } }

  const metaFile = zip.file("meta.json");
  if (metaFile) { try { result.meta = JSON.parse(await metaFile.async("string")); } catch { result.meta = {}; } }

  result.externals = {};
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith("externals/") || path.endsWith("/")) continue;
    const entry = zip.files[path]; if (entry.dir) continue;
    result.externals[path.slice("externals/".length)] = await entry.async("string");
  }

  result.scripts = {};
  let scriptIndex: Record<string, string> | null = null;
  const indexFile = zip.file("scripts/index.json");
  if (indexFile) { try { scriptIndex = JSON.parse(await indexFile.async("string")); } catch { scriptIndex = null; } }
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith("scripts/") || path === "scripts/index.json" || path.endsWith("/")) continue;
    const entry = zip.files[path]; if (entry.dir) continue;
    const filename = path.slice("scripts/".length);
    const originalKey = scriptIndex?.[filename] ?? filename.replace(/\.(js|ts)$/, "");
    result.scripts[originalKey] = await entry.async("string");
  }

  return result;
}
