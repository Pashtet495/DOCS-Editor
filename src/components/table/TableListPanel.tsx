"use client";

import { useState } from "react";
import { Table2, Plus, Trash2, Pencil, FileSpreadsheet, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/store/editor-store";

/**
 * TableListPanel — shows a list of spreadsheet table documents with
 * "Add Table" button, open/rename/delete actions.
 */
export function TableListPanel() {
  const tableDocs = useEditorStore((s) => s.tableDocs);
  const createTableDoc = useEditorStore((s) => s.createTableDoc);
  const openTableEditor = useEditorStore((s) => s.openTableEditor);
  const deleteTableDoc = useEditorStore((s) => s.deleteTableDoc);
  const renameTableDoc = useEditorStore((s) => s.renameTableDoc);
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleCreate = () => {
    createTableDoc();
  };

  const handleRename = (id: string) => {
    renameTableDoc(id, renameValue || "Без названия");
    setRenamingId(null);
    setRenameValue("");
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border rounded-lg">
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center justify-between rounded-lg bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/50 border">
          <span className="flex items-center gap-2">
            <Table2 className="h-4 w-4" />
            Таблицы ({tableDocs.length})
          </span>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="p-2 space-y-2">
        <Button
          size="sm"
          variant="outline"
          className="w-full h-7 text-xs gap-1.5"
          onClick={handleCreate}
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить таблицу
        </Button>

        {tableDocs.length === 0 ? (
          <div className="text-center text-[11px] text-muted-foreground py-3">
            Нет таблиц. Создайте таблицу для расчётов.
          </div>
        ) : (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {tableDocs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center gap-1 rounded border p-1.5 text-xs bg-muted/20 hover:bg-muted/30"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 text-green-600 shrink-0" />
                {renamingId === doc.id ? (
                  <Input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(doc.id);
                      if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                    }}
                    className="h-5 text-xs flex-1"
                    autoFocus
                  />
                ) : (
                  <button
                    onClick={() => openTableEditor(doc.id)}
                    className="flex-1 text-left min-w-0"
                    title="Открыть редактор таблицы"
                  >
                    <div className="truncate font-medium">{doc.name}</div>
                    <div className="text-[9px] text-muted-foreground">
                      {doc.id} · {doc.rowCount}×{doc.colCount}
                      {doc.zones.length > 0 && ` · ${doc.zones.length} зон`}
                    </div>
                  </button>
                )}
                <button
                  onClick={() => {
                    setRenamingId(doc.id);
                    setRenameValue(doc.name);
                  }}
                  className="border rounded p-0.5 hover:bg-muted shrink-0"
                  title="Переименовать"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={() => deleteTableDoc(doc.id)}
                  className="border rounded p-0.5 hover:bg-muted text-destructive shrink-0"
                  title="Удалить таблицу"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
