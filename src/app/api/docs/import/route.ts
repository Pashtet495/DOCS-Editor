// DOCS unpacking — reads a .docs zip archive (or a plain .docx file) and
// returns its parts as JSON.
//
// Accepts either:
//   • multipart/form-data with a `file` field (the .docs or .docx upload)
//   • a raw zip body (Content-Type: application/zip or similar)
//
// For a plain .docx (not a zip), returns just the docx as base64 with empty
// map / embeddings / scripts / externals / meta objects.

import JSZip from "jszip";
import type { DocumentMap } from "@/lib/editor/types";

export const dynamic = "force-dynamic";

interface ImportResult {
  map: DocumentMap | null;
  embeddings: Record<string, number[]>;
  docxBlobBase64: string;
  scripts: Record<string, string>;
  externals: Record<string, string>;
  meta: Record<string, unknown>;
}

function emptyResult(docxBlobBase64 = ""): ImportResult {
  return {
    map: null,
    embeddings: {},
    docxBlobBase64,
    scripts: {},
    externals: {},
    meta: {},
  };
}

/** A ZIP archive starts with "PK" followed by one of {03,05,07}/{04,06,08}. */
function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const head = bytes.subarray(0, 4);
  return (
    head[0] === 0x50 && // 'P'
    head[1] === 0x4b && // 'K'
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)
  );
}

async function readUpload(req: Request): Promise<{ bytes: Uint8Array; filename?: string }> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (file instanceof File) {
      const buf = new Uint8Array(await file.arrayBuffer());
      return { bytes: buf, filename: file.name };
    }
    // Some clients send the raw file as the body with multipart CT but no
    // boundary — fall through to raw body parsing below.
  }

  const buf = new Uint8Array(await req.arrayBuffer());
  return { bytes: buf };
}

export async function POST(req: Request) {
  let upload: { bytes: Uint8Array; filename?: string };
  try {
    upload = await readUpload(req);
  } catch {
    return Response.json({ error: "Failed to read request body" }, { status: 400 });
  }

  const { bytes, filename } = upload;

  // Plain .docx — return just the base64.
  const looksLikeDocx =
    (filename?.toLowerCase().endsWith(".docx") ?? false) ||
    !isZip(bytes);

  if (looksLikeDocx) {
    return Response.json(emptyResult(Buffer.from(bytes).toString("base64")));
  }

  // Try as a .docs zip.
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    // Not a valid zip — assume it's a plain docx.
    const message = err instanceof Error ? err.message : "Unknown zip error";
    return Response.json({
      ...emptyResult(Buffer.from(bytes).toString("base64")),
      meta: { zipError: message },
    });
  }

  const result: ImportResult = emptyResult();

  // document.docx
  const docxFile = zip.file("document.docx");
  if (docxFile) {
    const docxBytes = await docxFile.async("uint8array");
    result.docxBlobBase64 = Buffer.from(docxBytes).toString("base64");
  }

  // map.json
  const mapFile = zip.file("map.json");
  if (mapFile) {
    try {
      result.map = JSON.parse(await mapFile.async("string")) as DocumentMap;
    } catch {
      result.map = null;
    }
  }

  // embeddings.json
  const embFile = zip.file("embeddings.json");
  if (embFile) {
    try {
      const parsed = JSON.parse(await embFile.async("string"));
      if (parsed && typeof parsed === "object") {
        result.embeddings = parsed as Record<string, number[]>;
      }
    } catch {
      result.embeddings = {};
    }
  }

  // meta.json
  const metaFile = zip.file("meta.json");
  if (metaFile) {
    try {
      const parsed = JSON.parse(await metaFile.async("string"));
      if (parsed && typeof parsed === "object") {
        result.meta = parsed as Record<string, unknown>;
      }
    } catch {
      result.meta = {};
    }
  }

  // externals/<id>.<ext>
  result.externals = {};
  const externalPrefix = "externals/";
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith(externalPrefix)) continue;
    if (path.endsWith("/")) continue;
    const entry = zip.files[path];
    if (entry.dir) continue;
    const name = path.slice(externalPrefix.length);
    result.externals[name] = await entry.async("string");
  }

  // scripts/<name>.<ext> — consult scripts/index.json to restore keys.
  const scriptsPrefix = "scripts/";
  let scriptIndex: Record<string, string> | null = null;
  const indexFile = zip.file("scripts/index.json");
  if (indexFile) {
    try {
      scriptIndex = JSON.parse(await indexFile.async("string"));
    } catch {
      scriptIndex = null;
    }
  }

  result.scripts = {};
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith(scriptsPrefix)) continue;
    if (path === "scripts/index.json") continue;
    if (path.endsWith("/")) continue;
    const entry = zip.files[path];
    if (entry.dir) continue;
    const filename = path.slice(scriptsPrefix.length);
    const originalKey =
      scriptIndex?.[filename] ?? filename.replace(/\.(js|ts)$/, "");
    result.scripts[originalKey] = await entry.async("string");
  }

  return Response.json(result);
}
