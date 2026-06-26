// ============================================================================
// RAG: per-block embeddings + cosine similarity search.
//
// Embeddings are computed via the /api/llm/embeddings route (OpenAI-compatible).
// The block map is re-indexed when blocks change (debounced) and the vectors
// live alongside the Block objects so they serialize into the DOCS archive.
// ============================================================================

import type { Block, RagHit } from "../editor/types";
import { textOfBlock } from "../editor/pmMap";

export interface EmbedResponse {
  embeddings: number[][];
  error?: string;
}

export async function fetchEmbeddings(
  baseUrl: string,
  apiKey: string,
  model: string,
  inputs: string[],
): Promise<EmbedResponse> {
  if (!model) return { embeddings: [], error: "no embedding model selected" };
  const res = await fetch("/api/llm/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl, apiKey, model, input: inputs }),
  });
  return (await res.json()) as EmbedResponse;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function embedQuery(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: string,
): Promise<{ vector: number[]; error?: string }> {
  const r = await fetchEmbeddings(baseUrl, apiKey, model, [query]);
  return { vector: r.embeddings?.[0] ?? [], error: r.error };
}

/** Index all blocks that lack an embedding for the current model. */
export async function reindexBlocks(
  baseUrl: string,
  apiKey: string,
  model: string,
  blocks: Block[],
  batchSize = 16,
  matryoshkaDim = 0,
): Promise<{ blocks: Block[]; embedded: number; error?: string }> {
  if (!model) return { blocks, embedded: 0, error: "no embedding model selected" };
  const next = blocks.map((b) => ({ ...b }));
  let embedded = 0;
  for (let i = 0; i < next.length; i += batchSize) {
    const slice = next.slice(i, i + batchSize);
    const toEmbed = slice.filter((b) => b.embeddingModel !== model || !b.embedding || (matryoshkaDim > 0 && (b.embedding?.length ?? 0) !== matryoshkaDim));
    if (toEmbed.length === 0) continue;
    const texts = toEmbed.map((b) => textOfBlock(b));
    const r = await fetchEmbeddings(baseUrl, apiKey, model, texts);
    if (r.error) return { blocks: next, embedded, error: r.error };
    toEmbed.forEach((b, j) => {
      let vec = r.embeddings[j]?.map((v: number) => Math.round(v * 1e6) / 1e6) ?? [];
      // Matryoshka truncation: keep only first N dimensions (requires MRL model).
      if (matryoshkaDim > 0 && vec.length > matryoshkaDim) {
        vec = vec.slice(0, matryoshkaDim);
      }
      b.embedding = vec;
      b.embeddingModel = model;
      embedded++;
    });
  }
  return { blocks: next, embedded };
}

/** Search blocks by query embedding; returns top-k hits above threshold. */
export async function ragSearch(
  baseUrl: string,
  apiKey: string,
  model: string,
  blocks: Block[],
  query: string,
  k = 6,
  threshold = 0.2,
  matryoshkaDim = 0,
): Promise<{ hits: RagHit[]; error?: string }> {
  const q = await embedQuery(baseUrl, apiKey, model, query);
  if (q.error) return { hits: [], error: q.error };
  // Truncate query vector to match stored block embeddings.
  if (matryoshkaDim > 0 && q.vector.length > matryoshkaDim) {
    q.vector = q.vector.slice(0, matryoshkaDim);
  }
  if (!q.vector.length) return { hits: [] };
  const scored = blocks
    .filter((b) => b.embedding && b.embedding.length === q.vector.length)
    .map((b) => ({
      blockId: b.id,
      score: cosine(q.vector, b.embedding!),
      snippet: textOfBlock(b).slice(0, 220),
    }))
    .filter((h) => h.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return { hits: scored };
}
