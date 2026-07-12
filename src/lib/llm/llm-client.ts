// ============================================================================
// Client-side LLM helpers — direct fetch to OpenAI-compatible providers.
//
// All requests go DIRECT to the provider (no proxy). This works because:
//  - In Electron: the renderer can make cross-origin requests to localhost
//    (Chromium in Electron allows this by default; LM Studio also sets
//    permissive CORS headers).
//  - In browser dev mode: LM Studio and Ollama both set
//    `Access-Control-Allow-Origin: *`, so direct fetch works from
//    localhost:3000 too.
//
// The old Next.js API routes (/api/llm/*) were removed when we migrated
// to Electron — they no longer exist, so we don't fall back to them.
// ============================================================================

interface ChatParams {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
}

interface ChatResult {
  content: string;
  error?: string;
}

/**
 * Check if we're running inside Electron.
 * The preload script (electron/preload.js) exposes `window.electron.isElectron = true`
 * via contextBridge. We check that first, then fall back to a userAgent check.
 * Note: `window.process` is NOT available in the renderer when
 * `contextIsolation: true` + `nodeIntegration: false` (our Electron config),
 * so we can't use it to detect Electron.
 */
function isElectron(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { electron?: { isElectron?: boolean } };
  if (w.electron?.isElectron) return true;
  if (typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent)) {
    return true;
  }
  return false;
}

/** Strip a trailing slash from a base URL and return it. */
function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

/** Build the auth headers (Authorization: Bearer <key>) if an API key is set. */
function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Chat completion — calls the OpenAI-compatible provider directly.
 * POST ${baseUrl}/chat/completions
 */
export async function llmChat(params: ChatParams): Promise<ChatResult> {
  const { baseUrl, apiKey, model, messages, temperature = 0.7 } = params;

  if (!baseUrl) return { content: "", error: "baseUrl is required" };
  if (!model) return { content: "", error: "model is required" };

  const url = `${cleanBaseUrl(baseUrl)}/chat/completions`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ model, messages, temperature }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { content: "", error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    return { content, error: content ? undefined : "Empty response" };
  } catch (e) {
    return { content: "", error: e instanceof Error ? e.message : "Network error" };
  }
}

/**
 * Embeddings — calls the OpenAI-compatible provider directly.
 * POST ${baseUrl}/embeddings
 */
export async function llmEmbeddings(params: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  input: string | string[];
}): Promise<{ embeddings: number[][]; error?: string }> {
  const { baseUrl, apiKey, model, input } = params;

  if (!baseUrl) return { embeddings: [], error: "baseUrl is required" };

  const url = `${cleanBaseUrl(baseUrl)}/embeddings`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ model, input }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { embeddings: [], error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json();
    const embeddings = (data?.data ?? []).map(
      (d: { embedding?: number[] }) => d.embedding ?? [],
    );
    return { embeddings };
  } catch (e) {
    return { embeddings: [], error: e instanceof Error ? e.message : "Network error" };
  }
}

/**
 * List models — calls the OpenAI-compatible provider directly.
 * GET ${baseUrl}/models
 *
 * IMPORTANT: The OpenAI `/v1/models` endpoint only accepts GET (no body).
 * Using POST here causes HTTP 404 on LM Studio and other compliant servers.
 */
export async function llmModels(params: {
  baseUrl: string;
  apiKey?: string;
}): Promise<{ models: Array<{ id: string; name: string }>; error?: string }> {
  const { baseUrl, apiKey } = params;

  if (!baseUrl) return { models: [], error: "baseUrl is required" };

  const url = `${cleanBaseUrl(baseUrl)}/models`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...authHeaders(apiKey),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { models: [], error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json();
    const models = (data?.data ?? []).map((m: { id: string }) => ({
      id: m.id,
      name: m.id,
    }));
    return { models };
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : "Network error" };
  }
}
