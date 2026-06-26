// Lists available models from an OpenAI-compatible provider (LM Studio, Ollama,
// OpenAI, ...). The provider base URL and API key are always read from the
// request body — never hardcoded.

import type { ModelOption } from "@/lib/editor/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let baseUrl = "";
  let apiKey = "";

  try {
    const body = await req.json();
    baseUrl = body?.baseUrl ?? "";
    apiKey = body?.apiKey ?? "";
  } catch {
    return Response.json({ models: [], error: "Invalid JSON body" });
  }

  if (!baseUrl) {
    return Response.json({ models: [], error: "baseUrl is required" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return Response.json({
        models: [],
        error: `Provider responded ${res.status}: ${text.slice(0, 500)}`,
      });
    }

    const data = await res.json();
    const raw: unknown = data?.data ?? data?.models ?? [];
    const models: ModelOption[] = Array.isArray(raw)
      ? raw.map((m: Record<string, unknown>) => ({
          id: String(m?.id ?? m?.name ?? ""),
          object: typeof m?.object === "string" ? m.object : undefined,
          owned_by: typeof m?.owned_by === "string" ? m.owned_by : undefined,
        }))
      : [];

    return Response.json({ models });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Request timed out after 10s"
          : err.message
        : "Unknown error";
    return Response.json({ models: [], error: message });
  } finally {
    clearTimeout(timeout);
  }
}
