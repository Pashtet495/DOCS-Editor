"use client";

import { Loader2, Plug, AlertCircle, CheckCircle2, User, Bot, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEditorStore } from "@/store/editor-store";

const USER_COLORS = [
  { value: "#10b981", label: "Зелёный" },
  { value: "#6366f1", label: "Индиго" },
  { value: "#ef4444", label: "Красный" },
  { value: "#f59e0b", label: "Оранжевый" },
  { value: "#8b5cf6", label: "Фиолетовый" },
  { value: "#06b6d4", label: "Голубой" },
  { value: "#ec4899", label: "Розовый" },
  { value: "#84cc16", label: "Лайм" },
];

export function SettingsPanel() {
  const llm = useEditorStore((s) => s.llm);
  const models = useEditorStore((s) => s.models);
  const modelsLoading = useEditorStore((s) => s.modelsLoading);
  const modelsError = useEditorStore((s) => s.modelsError);
  const setLlm = useEditorStore((s) => s.setLlm);
  const loadModels = useEditorStore((s) => s.loadModels);
  const user = useEditorStore((s) => s.user);
  const agentUser = useEditorStore((s) => s.agentUser);
  const setUser = useEditorStore((s) => s.setUser);
  const setAgentUser = useEditorStore((s) => s.setAgentUser);
  const applyUserAndRemount = useEditorStore((s) => s.applyUserAndRemount);
  const ready = useEditorStore((s) => s.ready);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Plug className="h-4 w-4 text-primary" />
          Подключение нейросети
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          OpenAI-совместимый API. По умолчанию — локальный LM Studio.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="baseurl" className="text-xs">Base URL</Label>
          <Input
            id="baseurl"
            value={llm.baseUrl}
            onChange={(e) => setLlm({ baseUrl: e.target.value })}
            placeholder="http://localhost:1234/v1"
            className="text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="apikey" className="text-xs">API Key</Label>
          <Input
            id="apikey"
            type="password"
            value={llm.apiKey}
            onChange={(e) => setLlm({ apiKey: e.target.value })}
            placeholder="lm-studio"
            className="text-sm"
          />
        </div>

        <Button onClick={() => loadModels()} disabled={modelsLoading} className="w-full gap-2" size="sm">
          {modelsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {modelsLoading ? "Загрузка…" : "Загрузить модели"}
        </Button>

        {modelsError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">{modelsError}</AlertDescription>
          </Alert>
        )}

        {!modelsError && models.length > 0 && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Найдено моделей: {models.length}
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label className="text-xs">Чат-модель (LLM)</Label>
          <Select value={llm.chatModel} onValueChange={(v) => setLlm({ chatModel: v })}>
            <SelectTrigger className="text-sm">
              <SelectValue placeholder={models.length ? "Выберите модель" : "Сначала загрузите модели"} />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-sm">
                  <span className="font-mono">{m.id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Используется для генерации JSON-команд редактора.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Модель эмбеддингов</Label>
          <Select value={llm.embeddingModel} onValueChange={(v) => setLlm({ embeddingModel: v })}>
            <SelectTrigger className="text-sm">
              <SelectValue placeholder={models.length ? "Выберите модель" : "Сначала загрузите модели"} />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-sm">
                  <span className="font-mono">{m.id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Нужна для RAG-поиска по блокам документа. Обычно содержит «embed» в названии.
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs">Matryoshka (MRL)</Label>
            <span className="text-[10px] text-muted-foreground cursor-help" title="Matryoshka Representation Learning — обрезка вектора эмбеддинга до указанной размерности. Меньшие значения ухудшают качество семантического поиска, но уменьшают размер файла сохранения. Большие значения улучшают качество, но увеличивают размер файла. Выключите (off), если модель не поддерживает MRL.">
              ⓘ
            </span>
          </div>
          <Select
            value={String(llm.matryoshkaDim || 0)}
            onValueChange={(v) => setLlm({ matryoshkaDim: parseInt(v, 10) })}
          >
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">off (полный вектор)</SelectItem>
              <SelectItem value="128">128</SelectItem>
              <SelectItem value="256">256</SelectItem>
              <SelectItem value="512">512</SelectItem>
              <SelectItem value="768">768</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Обрезка размерности вектора. Меньше = меньше файл, хуже поиск. Больше = лучше поиск, больше файл.
          </p>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Как подключить LM Studio:</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>Запустите LM Studio → вкладка Developer / Local Server</li>
            <li>Загрузите модель и нажмите Start Server</li>
            <li>Порт по умолчанию — 1234, URL выше уже заполнен</li>
            <li>Нажмите «Загрузить модели» — появятся в списках</li>
          </ol>
        </div>

        {/* User identity */}
        <div className="border-t pt-4 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <User className="h-4 w-4" style={{ color: user.color }} />
            Пользователь
          </h3>
          <div className="space-y-1.5">
            <Label className="text-xs">Имя</Label>
            <Input value={user.name} onChange={(e) => setUser({ name: e.target.value })} className="text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Email</Label>
            <Input value={user.email} onChange={(e) => setUser({ email: e.target.value })} className="text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Цвет</Label>
            <Select value={user.color} onValueChange={(v) => setUser({ color: v })}>
              <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {USER_COLORS.map((c) => (
                  <SelectItem key={c.value} value={c.value} className="text-sm">
                    <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full inline-block" style={{ background: c.value }} />{c.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={() => void applyUserAndRemount()} disabled={!ready}>
            <RotateCw className="h-3.5 w-3.5" /> Применить
          </Button>
        </div>

        {/* AI agent identity */}
        <div className="border-t pt-4 space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Bot className="h-4 w-4" style={{ color: agentUser.color }} />
            AI-агент
          </h3>
          <div className="space-y-1.5">
            <Label className="text-xs">Имя</Label>
            <Input value={agentUser.name} onChange={(e) => setAgentUser({ name: e.target.value })} className="text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Email</Label>
            <Input value={agentUser.email} onChange={(e) => setAgentUser({ email: e.target.value })} className="text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Цвет</Label>
            <Select value={agentUser.color} onValueChange={(v) => setAgentUser({ color: v })}>
              <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {USER_COLORS.map((c) => (
                  <SelectItem key={c.value} value={c.value} className="text-sm">
                    <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full inline-block" style={{ background: c.value }} />{c.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}
