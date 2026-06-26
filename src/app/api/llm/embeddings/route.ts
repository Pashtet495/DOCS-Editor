// Embeddings endpoint — proxies to ${baseUrl}/embeddings on an
// OpenAI-compatible provider. Always returns an array of vectors (one per
// input item). A single string input is treated as a one-element array.

interface EmbeddingsBody {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  input?: string | string[];
}

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: EmbeddingsBody = {};

  try {
    body = (await req.json()) as EmbeddingsBody;
  } catch {
    return Response.json({ embeddings: [], error: "Invalid JSON body" });
  }

  const { baseUrl, apiKey, model, input } = body;

  if (!baseUrl) {
    return Response.json({ embeddings: [], error: "baseUrl is required" });
  }
  if (!model) {
    return Response.json({ embeddings: [], error: "model is required" });
  }
  if (input === undefined || input === null) {
    return Response.json({ embeddings: [], error: "input is required" });
  }

  const inputArray = Array.isArray(input) ? input : [input];
  if (inputArray.length === 0) {
    return Response.json({ embeddings: [] });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: inputArray }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return Response.json({
        embeddings: [],
        error: `Provider responded ${res.status}: ${text.slice(0, 500)}`,
      });
    }

    const data = await res.json();
    const raw: unknown = data?.data;
    const embeddings: number[][] = Array.isArray(raw)
      ? raw
          .map((item: Record<string, unknown>) =>
            Array.isArray(item?.embedding) ? (item.embedding as number[]) : null,
          )
          .filter((v: number[] | null): v is number[] => Array.isArray(v))
      : [];

    return Response.json({ embeddings });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Request timed out after 60s"
          : err.message
        : "Unknown error";
    return Response.json({ embeddings: [], error: message });
  } finally {
    clearTimeout(timeout);
  }
}
