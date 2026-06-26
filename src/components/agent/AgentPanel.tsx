"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, Database, Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/store/editor-store";
import type { AgentCommand, ChatMessage } from "@/lib/editor/types";

export function AgentPanel() {
  const chat = useEditorStore((s) => s.chat);
  const applying = useEditorStore((s) => s.applying);
  const syncing = useEditorStore((s) => s.syncing);
  const ragHits = useEditorStore((s) => s.ragHits);
  const sendMessage = useEditorStore((s) => s.sendMessage);
  const applyCommands = useEditorStore((s) => s.applyCommands);
  const rejectCommands = useEditorStore((s) => s.rejectCommands);
  const reindex = useEditorStore((s) => s.reindex);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat, applying]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || applying) return;
    setInput("");
    void sendMessage(text);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">AI-агент документа</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void reindex()} disabled={syncing} className="h-8 gap-1.5">
          {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
          <span className="text-xs">RAG</span>
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4">
        <div className="space-y-4 py-4">
          {chat.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              applying={applying}
              onApply={applyCommands}
              onReject={rejectCommands}
            />
          ))}
          {applying && (
            <div className="flex items-center gap-1.5 pl-2 text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
              <span className="ml-2 text-xs">агент думает…</span>
            </div>
          )}
        </div>
      </div>

      {ragHits.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t px-4 py-2">
          <span className="text-xs text-muted-foreground self-center">RAG:</span>
          {ragHits.map((h) => (
            <Badge key={h.blockId} variant="secondary" className="text-xs font-normal">
              {h.blockId} <span className="ml-1 text-muted-foreground">{h.score.toFixed(2)}</span>
            </Badge>
          ))}
        </div>
      )}

      <div className="border-t p-3">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Опишите правку документа… (Enter — отправить, Shift+Enter — перенос)"
          rows={2}
          className="resize-none text-sm"
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={handleSend} disabled={!input.trim() || applying} className="gap-1.5">
            <Send className="h-3.5 w-3.5" />
            Отправить
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  applying,
  onApply,
  onReject,
}: {
  msg: ChatMessage;
  applying: boolean;
  onApply: (c: AgentCommand[]) => void;
  onReject: () => void;
}) {
  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";

  return (
    <div className={cn("flex flex-col gap-2", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
          isUser && "bg-primary text-primary-foreground",
          isAssistant && "bg-muted",
          msg.role === "system" && "bg-muted/50 text-muted-foreground italic text-xs",
        )}
      >
        {msg.content}
      </div>

      {msg.commands && msg.commands.length > 0 && (
        <div className="w-full rounded-lg border bg-card p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Превью команд ({msg.commands.length})
            </span>
          </div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {msg.commands.map((c, i) => (
              <div key={i} className="rounded border bg-muted/40 px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {c.cmd}
                  </Badge>
                  {summarizeCommand(c)}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" className="h-7 gap-1.5" onClick={() => onApply(msg.commands!)} disabled={applying}>
              <Check className="h-3.5 w-3.5" />
              Применить
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={onReject} disabled={applying}>
              <X className="h-3.5 w-3.5" />
              Отклонить
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function summarizeCommand(c: AgentCommand): React.ReactNode {
  switch (c.cmd) {
    case "EDIT_BLOCK":
      return (
        <span className="text-muted-foreground">
          <span className="font-mono">{c.blockId}</span>
          {c.newContent != null ? ` → "${truncate(c.newContent, 50)}"` : c.find ? ` найти «${truncate(c.find, 30)}»` : ""}
        </span>
      );
    case "CREATE_BLOCK":
      return (
        <span className="text-muted-foreground">
          после <span className="font-mono">{c.afterBlockId ?? "начала"}</span> → {String(c.newBlock.type)}{" "}
          <span className="font-mono">{String(c.newBlock.id)}</span>
        </span>
      );
    case "DELETE_BLOCK":
      return <span className="text-muted-foreground">удалить <span className="font-mono">{c.blockId}</span></span>;
    case "MOVE_BLOCK":
      return (
        <span className="text-muted-foreground">
          <span className="font-mono">{c.blockId}</span> → после <span className="font-mono">{c.afterBlockId ?? "начала"}</span>
        </span>
      );
    case "UPDATE_STYLE":
      return (
        <span className="text-muted-foreground">
          <span className="font-mono">{c.blockId}</span> → стиль <span className="font-mono">{c.styleId}</span>
        </span>
      );
    case "INSERT_CANVAS":
      return (
        <span className="text-muted-foreground">
          canvas ({c.lang}) после <span className="font-mono">{c.afterBlockId ?? "начала"}</span>
          {c.title ? `: ${c.title}` : ""}
        </span>
      );
    case "LINK_RESOURCE":
      return (
        <span className="text-muted-foreground">
          ссылка на <span className="font-mono">{c.resourceId}</span> {c.query ? `(${c.query})` : ""}
        </span>
      );
    case "CREATE_RESOURCE":
      return (
        <span className="text-muted-foreground">
          ресурс «{c.name}» ({c.type})
        </span>
      );
    case "SET_TITLE":
      return <span className="text-muted-foreground">заголовок: «{c.title}»</span>;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
