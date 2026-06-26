// Non-streaming chat completion against an OpenAI-compatible provider.
// On error returns 200 with `{ content: "", error }` so the UI can surface the
// message without raising an exception in the caller.

interface ChatBody {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  temperature?: number;
}

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: ChatBody = {};

  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return Response.json({ content: "", error: "Invalid JSON body" });
  }

  const { baseUrl, apiKey, model, messages, temperature } = body;

  if (!baseUrl) {
    return Response.json({ content: "", error: "baseUrl is required" });
  }
  if (!model) {
    return Response.json({ content: "", error: "model is required" });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ content: "", error: "messages must be a non-empty array" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: typeof temperature === "number" ? temperature : 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return Response.json({
        content: "",
        error: `Provider responded ${res.status}: ${text.slice(0, 500)}`,
      });
    }

    const data = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";

    return Response.json({ content });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Request timed out after 120s"
          : err.message
        : "Unknown error";
    return Response.json({ content: "", error: message });
  } finally {
    clearTimeout(timeout);
  }
}
