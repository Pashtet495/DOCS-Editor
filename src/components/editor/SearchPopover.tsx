"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Search, Sparkles, Loader2, ChevronUp, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useEditorStore } from "@/store/editor-store";

interface SearchMatch {
  blockId?: string;
  text: string;
  pos?: number;
  fromRag?: boolean;
  score?: number;
}

/**
 * Unified search popover — combines:
 *   1. Text search via superdoc.search(text) + goToSearchResult(match)
 *   2. Vector search (RAG) via embeddings API
 * Both result types appear in one list. Clicking a result navigates to it
 * (text matches via goToSearchResult, RAG hits via scrollToElement/blockId).
 */
export function SearchPopover() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"text" | "vector" | "both">("both");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const superdoc = useEditorStore((s) => s.superdoc);
  const llm = useEditorStore((s) => s.llm);
  const blocks = useEditorStore((s) => s.blocks);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const doSearch = useCallback(async () => {
    if (!query.trim() || !superdoc) return;
    setSearching(true);
    setMatches([]);
    setCurrentIdx(0);
    const results: SearchMatch[] = [];

    try {
      // 1. Text search via superdoc API.
      if (mode === "text" || mode === "both") {
        const sd = superdoc as unknown as {
          search: (text: string | RegExp) => Array<{ from?: number; to?: number; text?: string }> | undefined;
          goToSearchResult: (match: unknown) => boolean | undefined;
        };
        const textMatches = sd.search(query);
        if (textMatches) {
          for (const m of textMatches.slice(0, 20)) {
            results.push({
              text: m.text || query,
              pos: m.from,
              fromRag: false,
            });
          }
        }
      }

      // 2. Vector search (RAG) via embeddings.
      if ((mode === "vector" || mode === "both") && llm.embeddingModel && blocks.length > 0) {
        const { llmEmbeddings } = await import("@/lib/llm/llm-client");
        const { embeddings: embResult, error: embError } = await llmEmbeddings({
          baseUrl: llm.baseUrl,
          apiKey: llm.apiKey,
          model: llm.embeddingModel,
          input: [query],
        });
        if (embResult?.[0]) {
          let qVec = embResult[0] as number[];
          // Matryoshka truncation for query vector.
          const mrlDim = (llm as { matryoshkaDim?: number }).matryoshkaDim || 0;
          if (mrlDim > 0 && qVec.length > mrlDim) qVec = qVec.slice(0, mrlDim);
          const scored = blocks
            .filter((b) => b.embedding && b.embedding.length === qVec.length)
            .map((b) => ({
              block: b,
              score: cosine(qVec, b.embedding!),
            }))
            .filter((x) => x.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
          for (const s of scored) {
            results.push({
              blockId: s.block.id,
              text: textOfBlock(s.block).slice(0, 120),
              fromRag: true,
              score: s.score,
            });
          }
        }
      }

      setMatches(results);
      if (results.length > 0) {
        navigateTo(0, results);
      }
    } catch (e) {
      console.error("[search] failed", e);
    } finally {
      setSearching(false);
    }
  }, [query, superdoc, mode, llm, blocks]);

  const navigateTo = useCallback(
    (idx: number, list?: SearchMatch[]) => {
      const items = list || matches;
      const m = items[idx];
      if (!m || !superdoc) return;
      setCurrentIdx(idx);

      if (m.fromRag && m.blockId) {
        // For RAG hits, try to scroll to the block via blockId.
        // We use the block's text signature to find a DOM element.
        const sd = superdoc as unknown as {
          scrollToElement: (id: string) => Promise<boolean>;
        };
        // Try scrolling to the block's data-sd-block-id attribute.
        void sd.scrollToElement?.(m.blockId);
      } else if (m.pos != null) {
        // Text match — use goToSearchResult.
        const sd = superdoc as unknown as {
          goToSearchResult: (match: unknown) => boolean | undefined;
        };
        // Re-run search to populate internal match state, then navigate.
        sd.goToSearchResult({ from: m.pos, to: m.pos + query.length });
      }
    },
    [matches, superdoc, query],
  );

  const next = () => navigateTo(Math.min(currentIdx + 1, matches.length - 1));
  const prev = () => navigateTo(Math.max(currentIdx - 1, 0));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Поиск (текст + векторный)">
          <Search className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <div className="border-b p-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void doSearch();
                  }
                }}
                placeholder="Поиск: текст или семантика…"
                className="h-8 pl-8 pr-8 text-sm"
              />
              {searching && (
                <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin" />
              )}
            </div>
            <Button size="sm" className="h-8 px-2" onClick={() => void doSearch()} disabled={!query.trim() || searching}>
              Найти
            </Button>
          </div>
          {/* Mode toggle */}
          <div className="flex items-center gap-1">
            {(["text", "both", "vector"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? "secondary" : "ghost"}
                className="h-6 px-2 text-[10px] gap-1"
                onClick={() => setMode(m)}
              >
                {m === "text" && <Search className="h-3 w-3" />}
                {m === "vector" && <Sparkles className="h-3 w-3" />}
                {m === "both" && <><Search className="h-3 w-3" /><Sparkles className="h-3 w-3" /></>}
                {m === "text" ? "Текст" : m === "vector" ? "Вектор" : "Оба"}
              </Button>
            ))}
          </div>
        </div>

        {/* Results */}
        {matches.length > 0 && (
          <div className="border-b px-2 py-1.5 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {currentIdx + 1} / {matches.length}
              {matches.filter((m) => m.fromRag).length > 0 && (
                <Badge variant="outline" className="ml-2 text-[9px] gap-0.5">
                  <Sparkles className="h-2.5 w-2.5" />
                  {matches.filter((m) => m.fromRag).length} RAG
                </Badge>
              )}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={prev} disabled={currentIdx === 0}>
                <ChevronUp className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={next} disabled={currentIdx >= matches.length - 1}>
                <ChevronDown className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { setMatches([]); setQuery(""); }}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}

        {/* Match list */}
        {matches.length > 0 && (
          <div className="max-h-64 overflow-y-auto p-1 space-y-0.5">
            {matches.map((m, i) => (
              <button
                key={i}
                className={`w-full text-left rounded px-2 py-1.5 text-xs hover:bg-muted/50 ${i === currentIdx ? "bg-muted" : ""}`}
                onClick={() => navigateTo(i)}
              >
                <div className="flex items-center gap-1.5">
                  {m.fromRag ? (
                    <Badge variant="outline" className="text-[9px] gap-0.5 shrink-0">
                      <Sparkles className="h-2.5 w-2.5" />
                      {m.score?.toFixed(2)}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[9px] shrink-0">
                      текст
                    </Badge>
                  )}
                  <span className="truncate">{m.text}</span>
                </div>
                {m.blockId && (
                  <span className="text-[10px] text-muted-foreground font-mono">{m.blockId}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {matches.length === 0 && !searching && query && (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Введите запрос и нажмите «Найти»
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function textOfBlock(b: import("@/lib/editor/types").Block): string {
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
