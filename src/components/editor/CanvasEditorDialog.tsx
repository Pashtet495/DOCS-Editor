"use client";

import { useEffect, useState } from "react";
import { Code2, Eye, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/store/editor-store";
import { renderCanvasPreview } from "@/lib/editor/superdoc-bridge";
import type { AgentCommand } from "@/lib/editor/types";

interface CanvasEditorState {
  blockId: string | null;
  code: string;
  lang: "js" | "ts";
  title: string;
}

export function CanvasEditorDialog() {
  const canvasEditor = useEditorStore((s) => s.canvasEditor);
  const closeCanvasEditor = useEditorStore((s) => s.closeCanvasEditor);

  if (!canvasEditor) return null;
  return (
    <Inner
      key={canvasEditor.blockId || "new"}
      state={canvasEditor}
      onClose={closeCanvasEditor}
    />
  );
}

function Inner({ state, onClose }: { state: CanvasEditorState; onClose: () => void }) {
  const applyCommands = useEditorStore((s) => s.applyCommands);
  const blocks = useEditorStore((s) => s.blocks);
  const llm = useEditorStore((s) => s.llm);

  const [title, setTitle] = useState(state.title);
  const [lang, setLang] = useState<"js" | "ts">(state.lang);
  const [code, setCode] = useState(state.code);
  const [afterBlockId, setAfterBlockId] = useState<string>(
    state.blockId || blocks[blocks.length - 1]?.id || "",
  );
  const [preview, setPreview] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState("");
  const [genError, setGenError] = useState<string | null>(null);

  // Debounced preview re-render.
  useEffect(() => {
    const t = setTimeout(() => {
      setPreview(renderCanvasPreview(code, lang));
    }, 400);
    return () => clearTimeout(t);
  }, [code, lang]);

  const generate = async () => {
    if (!genPrompt.trim() || !llm.chatModel) {
      setGenError(llm.chatModel ? "Введите описание визуализации" : "Сначала выберите чат-модель в Настройках");
      return;
    }
    setGenerating(true);
    setGenError(null);
    try {
      const sys = `You generate ONLY raw JavaScript code that draws on a 2D canvas. Output nothing except code — no markdown fences, no explanation. The code receives (canvas, ctx) where canvas.width=600 and canvas.height=320. Draw the requested visualization using ONLY ctx methods (fillRect, strokeRect, moveTo, lineTo, arc, fillText, etc.). Use colors, labels, axes where appropriate. Do NOT use canvas variable reassignment.`;
      const res = await fetch("/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: llm.baseUrl,
          apiKey: llm.apiKey,
          model: llm.chatModel,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: genPrompt },
          ],
          temperature: 0.3,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setGenError(data.error);
      } else {
        // Strip markdown fences if present.
        const cleaned = (data.content || "").replace(/^```(?:javascript|js)?\s*/m, "").replace(/```\s*$/m, "").trim();
        setCode(cleaned);
      }
    } catch (e) {
      setGenError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const insert = () => {
    const cmd: AgentCommand = {
      cmd: "INSERT_CANVAS",
      afterBlockId: afterBlockId || null,
      lang,
      code,
      title,
    };
    void applyCommands([cmd]);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[92vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Code2 className="h-4 w-4" />
            Canvas-вставка (JS/TS визуализация)
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2 flex-1 min-h-0 overflow-hidden">
          {/* Editor column */}
          <div className="flex flex-col gap-3 min-h-0">
            <div className="grid grid-cols-2 gap-3 flex-shrink-0">
              <div className="space-y-1.5">
                <Label className="text-xs">Название</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="График продаж" className="text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Язык</Label>
                <Select value={lang} onValueChange={(v) => setLang(v as "js" | "ts")}>
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="js">JavaScript</SelectItem>
                    <SelectItem value="ts">TypeScript</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5 flex-shrink-0">
              <Label className="text-xs">Вставить после блока</Label>
              <Select value={afterBlockId} onValueChange={setAfterBlockId}>
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="в конец документа" />
                </SelectTrigger>
                <SelectContent>
                  {blocks.map((b) => (
                    <SelectItem key={b.id} value={b.id} className="text-sm font-mono">
                      {b.id} ({b.type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* AI generation */}
            <div className="rounded-lg border bg-muted/30 p-2.5 space-y-2 flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Генерация через нейросеть
              </div>
              <Input
                value={genPrompt}
                onChange={(e) => setGenPrompt(e.target.value)}
                placeholder="Опишите визуализацию: столбчатая диаграмма продаж по кварталам"
                className="text-xs h-8"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={generate} disabled={generating || !genPrompt.trim()}>
                  {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  Сгенерировать код
                </Button>
                {genError && <span className="text-xs text-destructive">{genError}</span>}
              </div>
            </div>

            <div className="space-y-1.5 flex-1 min-h-0 flex flex-col">
              <Label className="text-xs flex-shrink-0">Код</Label>
              <Textarea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="font-mono text-xs flex-1 min-h-[180px] resize-none"
                placeholder={"// Доступно: canvas (600x320), ctx — 2D-контекст\nctx.fillStyle = '#10b981';\nctx.fillRect(20, 20, 200, 120);"}
              />
            </div>
          </div>

          {/* Preview column */}
          <div className="flex flex-col gap-2 min-h-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
              <Eye className="h-3.5 w-3.5" />
              Предпросмотр
            </div>
            <div className="rounded-lg border bg-white p-2 flex items-center justify-center min-h-[200px] flex-shrink-0">
              {preview ? (
                <img src={preview} alt="canvas preview" className="max-w-full h-auto" />
              ) : (
                <span className="text-xs text-muted-foreground">введите код для предпросмотра</span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground flex-shrink-0">
              Код выполняется в изолированной функции с аргументами <code className="font-mono">(canvas, ctx)</code>.
              В документ вставляется как изображение (data URL), поэтому корректно экспортируется в DOCX.
              Код также сохраняется как ресурс в разделе «Ресурсы» — его можно отредактировать позже.
            </p>
            {preview && (
              <div className="text-[11px] text-muted-foreground flex-shrink-0">
                <span className="font-medium">Сохранится как ресурс:</span> PNG {preview.length} байт,
                код {code.length} символов.
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex-shrink-0">
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
          <Button onClick={insert} disabled={!code.trim()}>
            Вставить в документ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
