// DOCS packaging — builds a .docs zip archive from a DOCX blob, the JSON
// Document Map (with per-block embeddings included), optional scripts and metadata.
//
// Archive layout:
//   document.docx
//   map.json              (DocumentMap, WITH embeddings in each block)
//   meta.json             ({ format: "DOCS", version, createdAt, ...meta })
//   externals/<id>.<ext>  (one file per externalResource)
//   scripts/<name>.<ext>  (one file per script; plus scripts/index.json for
//                          round-tripping the original map keys)

import JSZip from "jszip";
import type { DocumentMap } from "@/lib/editor/types";

interface ExportBody {
  docxBlobBase64?: string;
  map?: DocumentMap;
  embeddings?: Record<string, number[]>;
  scripts?: Record<string, string>;
  meta?: Record<string, unknown>;
}

export const dynamic = "force-dynamic";

const RESOURCE_EXT: Record<string, string> = {
  xml: "xml",
  json: "json",
  csv: "csv",
  canvas: "js",
};

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "script";
}

export async function POST(req: Request) {
  let body: ExportBody = {};

  try {
    body = (await req.json()) as ExportBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { docxBlobBase64, map, embeddings = {}, scripts = {}, meta = {} } = body;

  if (!docxBlobBase64 || typeof docxBlobBase64 !== "string") {
    return Response.json(
      { error: "docxBlobBase64 is required" },
      { status: 400 },
    );
  }

  const zip = new JSZip();

  // 1. document.docx — the raw DOCX binary.
  zip.file("document.docx", Buffer.from(docxBlobBase64, "base64"));

  // 2. map.json — DocumentMap WITH embeddings in each block.
  //    If the map blocks don't have embeddings yet, merge from the separate
  //    embeddings object (backward compat with older callers).
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

  // 3. meta.json — envelope metadata.
  zip.file(
    "meta.json",
    JSON.stringify(
      {
        format: "DOCS",
        version: "1.0.0",
        createdAt: new Date().toISOString(),
        ...meta,
      },
      null,
      2,
    ),
  );

  // 4. externals/<id>.<ext> — one file per ExternalResource.
  if (map?.externalResources) {
    for (const r of map.externalResources) {
      const ext = RESOURCE_EXT[r.type] ?? "txt";
      const content = r.type === "canvas" ? r.content : (r.content ?? "");
      zip.file(`externals/${r.id}.${ext}`, content);
    }
  }

  // 5. scripts/<name>.<ext> — one file per script.
  const scriptIndex: Record<string, string> = {};
  for (const [key, code] of Object.entries(scripts)) {
    let filename = sanitizeFilename(key);
    if (!/\.(js|ts)$/.test(filename)) filename += ".js";
    zip.file(`scripts/${filename}`, code ?? "");
    scriptIndex[filename] = key;
  }
  if (Object.keys(scriptIndex).length > 0) {
    zip.file("scripts/index.json", JSON.stringify(scriptIndex, null, 2));
  }

  const zipBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return new Response(zipBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="document.docs"',
      "Content-Length": String(zipBytes.length),
    },
  });
}
