"use client";

import { useState } from "react";
import { Plus, FileCode2, Trash2, Pencil, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { ExternalResource, ResourceType } from "@/lib/editor/types";

export function ResourcesPanel() {
  const resources = useEditorStore((s) => s.docMap.externalResources);
  const addResource = useEditorStore((s) => s.addResource);
  const updateResource = useEditorStore((s) => s.updateResource);
  const removeResource = useEditorStore((s) => s.removeResource);
  const [editing, setEditing] = useState<ExternalResource | null>(null);
  const [open, setOpen] = useState(false);

  const openNew = () => {
    setEditing({ id: "", name: "", type: "xml", content: "", description: "" });
    setOpen(true);
  };
  const openEdit = (r: ExternalResource) => {
    setEditing({ ...r });
    setOpen(true);
  };
  const save = () => {
    if (!editing) return;
    if (editing.id) {
      updateResource(editing.id, editing);
    } else {
      const { id: _id, ...rest } = editing;
      void _id;
      addResource(rest);
    }
    setOpen(false);
    setEditing(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-primary" />
          Внешние ресурсы
        </h3>
        <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={openNew}>
          <Plus className="h-3.5 w-3.5" />
          Добавить
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {resources.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <FileCode2 className="mx-auto mb-2 h-8 w-8 opacity-40" />
            Нет внешних ресурсов.
            <br />
            Добавьте XML/JSON/CSV таблицу, чтобы ссылаться на её значения в документе.
          </div>
        ) : (
          resources.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
                    {r.name}
                  </CardTitle>
                  <Badge variant="secondary" className="text-xs uppercase">
                    {r.type}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {r.description && (
                  <p className="text-xs text-muted-foreground">{r.description}</p>
                )}
                <pre className="max-h-24 overflow-auto rounded bg-muted/50 p-2 text-[11px] font-mono whitespace-pre-wrap break-all">
                  {r.content.slice(0, 240)}
                  {r.content.length > 240 ? "…" : ""}
                </pre>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={() => openEdit(r)}>
                    <Pencil className="h-3 w-3" />
                    Изменить
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-destructive" onClick={() => removeResource(r.id)}>
                    <Trash2 className="h-3 w-3" />
                    Удалить
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Редактировать ресурс" : "Новый ресурс"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Название</Label>
                  <Input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="Q1 Sales"
                    className="text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Тип</Label>
                  <Select
                    value={editing.type}
                    onValueChange={(v) => setEditing({ ...editing, type: v as ResourceType })}
                  >
                    <SelectTrigger className="text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="xml">XML</SelectItem>
                      <SelectItem value="json">JSON</SelectItem>
                      <SelectItem value="csv">CSV</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Описание</Label>
                <Input
                  value={editing.description || ""}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  placeholder="Квартальные продажи"
                  className="text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Содержимое</Label>
                <Textarea
                  value={editing.content}
                  onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                  rows={10}
                  className="font-mono text-xs"
                  placeholder={editing.type === "xml" ? "<root>\n  <item>1</item>\n</root>" : editing.type === "json" ? '{\n  "key": "value"\n}' : "a,b,c\n1,2,3"}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button onClick={save} disabled={!editing?.name || !editing?.content}>
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
