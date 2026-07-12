"use client";

import { useState, useCallback } from "react";
import { Table2, Plus, Trash2, Link2, Unlink, Check, AlertCircle, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/store/editor-store";
import {
  autoFillStoreToXmlTable,
  xmlTableToAutoFillStore,
  nextAutoFillFieldId,
  type AutoFillXmlTable,
  type AutoFillField,
  type AutoFillStore,
} from "@/lib/editor/autofill-types";

/**
 * AutoFillXmlEditorDialog
 *
 * A spreadsheet-like editor for the auto-fill store. Fields are columns,
 * variants are rows. Sync groups can be created by selecting multiple
 * columns and clicking "Связать".
 *
 * The dialog works on a LOCAL draft (AutoFillXmlTable) and only commits
 * to the store when "Сохранить" is clicked — this keeps the editor
 * transactional and avoids spamming the document with intermediate states.
 *
 * Implementation note: the editable content lives in a child component
 * (`AutoFillEditorContent`) that is mounted ONLY when the dialog is open.
 * This lets `useState` initialize directly from the store on mount — no
 * syncing effect required (which would violate the React 19
 * `set-state-in-effect` rule).
 */
export function AutoFillXmlEditorDialog() {
  const open = useEditorStore((s) => s.autoFillXmlEditorOpen);
  const setOpen = useEditorStore((s) => s.setAutoFillXmlEditorOpen);
  const autoFillStore = useEditorStore((s) => s.autoFillStore);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="!fixed !inset-0 !top-0 !left-0 !translate-x-0 !translate-y-0 w-screen h-screen !max-w-none !max-h-none sm:!max-w-none sm:!max-h-none sm:rounded-none flex flex-col p-0 gap-0"
        style={{ zIndex: 9999 }}
        showCloseButton
      >
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="h-5 w-5" />
            Таблица автозаполнения
          </DialogTitle>
          <DialogDescription>
            Поля — это столбцы, варианты значений — строки. Колонки с одинаковой
            синхронизацией меняются вместе при выборе значения в документе.
          </DialogDescription>
        </DialogHeader>
        {open && autoFillStore && (
          <AutoFillEditorContent
            initialStore={autoFillStore}
            onClose={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AutoFillEditorContent({
  initialStore,
  onClose,
}: {
  initialStore: AutoFillStore;
  onClose: () => void;
}) {
  const setAutoFillStore = useEditorStore((s) => s.setAutoFillStore);
  // Check which AF fields are linked to table cells
  const tableDocs = useEditorStore((s) => s.tableDocs);
  const linkedFieldIds = (() => {
    const ids = new Set<string>();
    for (const t of tableDocs) {
      for (const link of t.cellLinks) {
        ids.add(link.autoFillFieldId);
      }
    }
    return ids;
  })();

  /** Fields linked to a table cell that contains a FORMULA — these are
   *  read-only in the XML editor (value is computed, not user-editable). */
  const formulaLinkedFieldIds = (() => {
    const ids = new Set<string>();
    for (const t of tableDocs) {
      for (const link of t.cellLinks) {
        const cellIdSet = new Set(link.cellIds);
        for (const row of t.cells) {
          if (!row) continue;
          for (const cell of row) {
            if (cell?.linkId && cellIdSet.has(cell.linkId) && cell.raw.startsWith("=")) {
              ids.add(link.autoFillFieldId);
              break;
            }
          }
        }
      }
    }
    return ids;
  })();

  // Initialize the draft ONCE on mount from the store. Because this component
  // is remounted every time the dialog opens, the draft always starts fresh.
  // Note: draft.syncGroups carries mappings (not in AutoFillXmlTable type) so
  // cell-sync rules survive the save round-trip.
  const [draft, setDraft] = useState<AutoFillXmlTable & {
    syncGroups: Array<{ id: string; fieldIds: string[]; mappings?: Record<string, Record<string, string[]>> }>;
  }>(() => ({
    ...autoFillStoreToXmlTable(initialStore),
    syncGroups: initialStore.syncGroups.map((g) => ({
      id: g.id,
      fieldIds: g.fieldIds,
      mappings: g.mappings,
    })),
  }));
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  /** Cell-level sync mode: when true, every non-empty cell shows a checkbox. */
  const [cellSyncMode, setCellSyncMode] = useState(false);
  /** Selected cells in cell-sync mode: Set of "rowIdx-colIdx" strings. */
  const [selectedCells, setSelectedCells] = useState<Set<string>>(() => new Set());

  const addColumn = useCallback(() => {
    setDraft((d) => {
      const existingFields: AutoFillField[] = d.columns.map((c) => ({
        id: c.fieldId,
        label: c.label,
        description: c.description,
        originalText: "",
        variants: [],
        selectedValue: null,
        syncGroupId: null,
        insertMode: "single" as const,
      }));
      const newId = nextAutoFillFieldId(existingFields);
      return {
        ...d,
        columns: [
          ...d.columns,
          { fieldId: newId, label: `Поле ${newId}`, description: "" },
        ],
        rows: d.rows.map((row) => [...row, ""]),
      };
    });
  }, []);

  const removeColumn = useCallback((fieldId: string) => {
    setDraft((d) => {
      const idx = d.columns.findIndex((c) => c.fieldId === fieldId);
      if (idx < 0) return d;
      const columns = d.columns.filter((c) => c.fieldId !== fieldId);
      const rows = d.rows.map((row) => row.filter((_, i) => i !== idx));
      const syncGroups = d.syncGroups
        .map((g) => ({
          ...g,
          fieldIds: g.fieldIds.filter((fid) => fid !== fieldId),
        }))
        .filter((g) => g.fieldIds.length > 1);
      return { columns, rows, syncGroups };
    });
    setSelectedColumns((s) => {
      const next = new Set(s);
      next.delete(fieldId);
      return next;
    });
  }, []);

  const addRow = useCallback(() => {
    setDraft((d) => ({
      ...d,
      rows: [...d.rows, d.columns.map(() => "")],
    }));
  }, []);

  const removeRow = useCallback((rowIdx: number) => {
    setDraft((d) => ({
      ...d,
      rows: d.rows.filter((_, i) => i !== rowIdx),
    }));
  }, []);

  const updateCell = useCallback(
    (rowIdx: number, colIdx: number, value: string) => {
      // Block edits to a variant cell whose AF field is linked to a table
      // cell that contains a formula — those values are computed by the
      // table formula engine and must not be overwritten from this editor.
      const col = draft.columns[colIdx];
      if (col) {
        const fieldId = col.fieldId;
        for (const t of tableDocs) {
          const link = t.cellLinks.find((l) => l.autoFillFieldId === fieldId);
          if (!link) continue;
          const cellIdSet = new Set(link.cellIds);
          let blocked = false;
          for (const row of t.cells) {
            if (!row) continue;
            for (const cell of row) {
              if (cell?.linkId && cellIdSet.has(cell.linkId) && cell.raw.startsWith("=")) {
                blocked = true;
                break;
              }
            }
            if (blocked) break;
          }
          if (blocked) {
            toast.warning("Значение вычисляется формулой таблицы и не может быть изменено здесь", {
              description: `Поле ${fieldId} связано с ячейкой-формулой в таблице «${t.name}».`,
            });
            return;
          }
        }
      }
      setDraft((d) => {
        const rows = d.rows.map((row, i) =>
          i === rowIdx
            ? row.map((cell, j) => (j === colIdx ? value : cell))
            : row,
        );
        return { ...d, rows };
      });
    },
    [draft.columns, tableDocs],
  );

  const updateColumnMeta = useCallback(
    (fieldId: string, patch: Partial<{ label: string; description: string }>) => {
      setDraft((d) => ({
        ...d,
        columns: d.columns.map((c) =>
          c.fieldId === fieldId ? { ...c, ...patch } : c,
        ),
      }));
    },
    [],
  );

  const toggleSelectColumn = useCallback((fieldId: string) => {
    setSelectedColumns((s) => {
      const next = new Set(s);
      if (next.has(fieldId)) next.delete(fieldId);
      else next.add(fieldId);
      return next;
    });
  }, []);

  const createSyncGroup = useCallback(() => {
    setSelectedColumns((sel) => {
      if (sel.size < 2) return sel;
      const groupId = `SYNC${Date.now().toString(36)}`;
      setDraft((d) => ({
        ...d,
        syncGroups: [
          ...d.syncGroups,
          { id: groupId, fieldIds: Array.from(sel) },
        ],
      }));
      return new Set();
    });
  }, []);

  const removeSyncGroup = useCallback((groupId: string) => {
    setDraft((d) => ({
      ...d,
      syncGroups: d.syncGroups.filter((g) => g.id !== groupId),
    }));
  }, []);

  /** Toggle a cell's selection in cell-sync mode. */
  const toggleCell = useCallback((rowIdx: number, colIdx: number) => {
    const key = `${rowIdx}-${colIdx}`;
    setSelectedCells((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Create a list-sync rule from selected cells.
   *  Collects (fieldId, value) pairs from selected cells, groups by field,
   *  and builds bidirectional list mappings: for each field:value, all OTHER
   *  fields get the full list of their selected values. */
  const saveCellSync = useCallback(() => {
    // Collect selected cells as { fieldId, value } pairs (skip empty cells)
    const pairs: Array<{ fieldId: string; value: string }> = [];
    for (const key of selectedCells) {
      const [rowIdx, colIdx] = key.split("-").map(Number);
      const value = draft.rows[rowIdx]?.[colIdx];
      const col = draft.columns[colIdx];
      if (value && value.trim() && col) {
        pairs.push({ fieldId: col.fieldId, value: value.trim() });
      }
    }
    // Group by fieldId
    const byField = new Map<string, string[]>();
    for (const p of pairs) {
      const arr = byField.get(p.fieldId) || [];
      if (!arr.includes(p.value)) arr.push(p.value);
      byField.set(p.fieldId, arr);
    }
    const fieldIds = Array.from(byField.keys());
    if (fieldIds.length < 2) {
      setError("Выберите ячейки минимум в 2 колонках");
      return;
    }

    // Build bidirectional list mappings
    const mappings: Record<string, Record<string, string[]>> = {};
    for (const [srcField, srcValues] of byField) {
      for (const srcVal of srcValues) {
        const mapKey = `${srcField}:${srcVal}`;
        const target: Record<string, string[]> = {};
        for (const [tgtField, tgtValues] of byField) {
          if (tgtField === srcField) continue;
          target[tgtField] = [...tgtValues];
        }
        mappings[mapKey] = target;
      }
    }

    // Find or create a sync group containing all these fields
    setDraft((d) => {
      // Check if all fields already share a group
      const existingGroups = fieldIds
        .map((fid) => d.syncGroups.find((g) => g.fieldIds.includes(fid)))
        .filter(Boolean);
      const allSame = existingGroups.length === fieldIds.length &&
        existingGroups.every((g) => g?.id === existingGroups[0]?.id);
      const groupId = allSame && existingGroups[0]
        ? existingGroups[0].id
        : `SYNC${Date.now().toString(36)}`;
      const existing = d.syncGroups.find((g) => g.id === groupId);
      // Merge mappings
      const mergedMappings = { ...(existing?.mappings || {}), ...mappings };
      // Ensure all fieldIds are in the group
      const mergedFieldIds = new Set([
        ...(existing?.fieldIds || []),
        ...fieldIds,
      ]);
      let syncGroups;
      if (existing) {
        syncGroups = d.syncGroups.map((g) =>
          g.id === groupId
            ? { ...g, fieldIds: Array.from(mergedFieldIds), mappings: mergedMappings }
            : g,
        );
      } else {
        syncGroups = [
          ...d.syncGroups,
          { id: groupId, fieldIds: Array.from(mergedFieldIds), mappings: mergedMappings },
        ];
      }
      return { ...d, syncGroups };
    });
    setSelectedCells(new Set());
    setCellSyncMode(false);
    setError(null);
  }, [selectedCells, draft.rows, draft.columns]);

  const handleSave = useCallback(() => {
    const emptyLabel = draft.columns.find((c) => !c.label.trim());
    if (emptyLabel) {
      setError(`Поле ${emptyLabel.fieldId}: название не может быть пустым`);
      return;
    }
    try {
      const newStore = xmlTableToAutoFillStore(draft);
      // Preserve sync group mappings from the draft
      newStore.syncGroups = newStore.syncGroups.map((g) => {
        const draftGroup = draft.syncGroups.find((dg) => dg.id === g.id);
        return draftGroup?.mappings ? { ...g, mappings: draftGroup.mappings } : g;
      });
      // PRESERVE selectedValue and instances from the OLD store.
      newStore.fields = newStore.fields.map((newField) => {
        const oldField = initialStore.fields.find((f) => f.id === newField.id);
        if (!oldField) return newField;
        // If the old selectedValue is still in the new variants, keep it
        const oldVal = oldField.selectedValue;
        let keepVal = oldVal != null && newField.variants.includes(oldVal) ? oldVal : null;
        // If old selectedValue is no longer valid but variants exist, select
        // the first variant (the user changed the value in the XML editor,
        // so the new value should be selected).
        if (keepVal === null && newField.variants.length > 0) {
          keepVal = newField.variants[0];
        }
        // Preserve instances' selectedValues too
        const oldInstances = oldField.instances || [{ suffix: "", selectedValue: null }];
        const newInstances = newField.instances.map((inst) => {
          const oldInst = oldInstances.find((oi) => oi.suffix === inst.suffix);
          if (oldInst && oldInst.selectedValue != null && newField.variants.includes(oldInst.selectedValue)) {
            return { ...inst, selectedValue: oldInst.selectedValue };
          }
          // Fall back to keepVal for the primary instance
          if (inst.suffix === "") {
            return { ...inst, selectedValue: keepVal };
          }
          return inst;
        });
        return {
          ...newField,
          selectedValue: keepVal,
          instances: newInstances.length > 0 ? newInstances : [{ suffix: "", selectedValue: keepVal }],
        };
      });
      // Also preserve activeInstance from old store
      newStore.activeInstance = initialStore.activeInstance || {};
      setAutoFillStore(newStore);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить таблицу");
    }
  }, [draft, setAutoFillStore, onClose, initialStore]);

  return (
    <div className="flex flex-col flex-1 min-h-0 px-6 pb-4 gap-2 overflow-hidden">
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive flex-shrink-0">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b pb-2 flex-shrink-0 flex-wrap">
        <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={addColumn} disabled={cellSyncMode}>
          <Plus className="h-3.5 w-3.5" />
          Поле
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={addRow} disabled={cellSyncMode}>
          <Plus className="h-3.5 w-3.5" />
          Вариант
        </Button>
        <div className="h-5 w-px bg-border mx-1" />
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5"
          onClick={createSyncGroup}
          disabled={selectedColumns.size < 2 || cellSyncMode}
          title={selectedColumns.size < 2 ? "Выберите ≥2 колонки" : "Создать группу синхронизации (по колонкам)"}
        >
          <Link2 className="h-3.5 w-3.5" />
          Связать колонки ({selectedColumns.size})
        </Button>
        {/* Cell-level sync mode toggle */}
        {cellSyncMode ? (
          <>
            <Button
              size="sm"
              variant="default"
              className="h-7 gap-1.5"
              onClick={saveCellSync}
              disabled={selectedCells.size < 2}
              title="Сохранить правило синхронизации из выбранных ячеек"
            >
              <Check className="h-3.5 w-3.5" />
              Сохранить связь ячеек ({selectedCells.size})
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              onClick={() => { setCellSyncMode(false); setSelectedCells(new Set()); }}
            >
              <X className="h-3.5 w-3.5" />
              Отмена
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5"
            onClick={() => setCellSyncMode(true)}
            title="Режим связывания ячеек — отметьте ячейки для создания списочной связи"
          >
            <Link2 className="h-3.5 w-3.5" />
            Связи ячеек
          </Button>
        )}
        {draft.syncGroups.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 ml-2">
            <span className="text-xs text-muted-foreground">Группы:</span>
            {draft.syncGroups.map((g) => {
              const mappingCount = Object.keys(g.mappings || {}).length;
              return (
                <Badge key={g.id} variant="secondary" className="text-[10px] gap-1">
                  {g.fieldIds.join(" ⇄ ")} ({mappingCount})
                  <button
                    onClick={() => removeSyncGroup(g.id)}
                    className="hover:text-destructive"
                    title="Удалить группу"
                  >
                    <Unlink className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}
      </div>

      {/* Table — scrollable */}
      <div className="flex-1 overflow-auto border rounded-md">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur">
            <tr>
              <th className="w-10 border-b border-r p-1 text-center text-[10px] text-muted-foreground">
                #
              </th>
              {draft.columns.map((col) => {
                const inSyncGroup = draft.syncGroups.some((g) =>
                  g.fieldIds.includes(col.fieldId),
                );
                const isSelected = selectedColumns.has(col.fieldId);
                return (
                  <th
                    key={col.fieldId}
                    className={`border-b border-r p-1 min-w-[140px] text-left ${
                      isSelected ? "bg-primary/10" : ""
                    } ${inSyncGroup ? "border-t-2 border-t-blue-400" : ""}`}
                  >
                    <div className="flex items-center gap-1 mb-1">
                      <button
                        onClick={() => toggleSelectColumn(col.fieldId)}
                        className={`h-4 w-4 rounded border flex items-center justify-center flex-shrink-0 ${
                          isSelected
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-input hover:bg-muted"
                        }`}
                        title={isSelected ? "Снять выделение" : "Выделить для связи"}
                      >
                        {isSelected && <Check className="h-3 w-3" />}
                      </button>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {col.fieldId}
                      </span>
                      {linkedFieldIds.has(col.fieldId) && (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span title="Синхронизировано с таблицей">
                                <Link2 className="h-3 w-3 text-blue-500" />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="text-xs">
                                <div className="font-medium">Синхронизировано с внешним ресурсом</div>
                                <div>Данные берутся из ячейки таблицы</div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      <button
                        onClick={() => removeColumn(col.fieldId)}
                        className="ml-auto text-muted-foreground hover:text-destructive"
                        title="Удалить колонку"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <Input
                      value={col.label}
                      onChange={(e) =>
                        updateColumnMeta(col.fieldId, { label: e.target.value })
                      }
                      className="h-6 text-xs mb-1"
                      placeholder="Название"
                    />
                    <Input
                      value={col.description}
                      onChange={(e) =>
                        updateColumnMeta(col.fieldId, { description: e.target.value })
                      }
                      className="h-6 text-[10px] text-muted-foreground"
                      placeholder="Описание (для ИИ)"
                    />
                  </th>
                );
              })}
              <th className="w-10 border-b p-1" />
            </tr>
          </thead>
          <tbody>
            {draft.rows.length === 0 && (
              <tr>
                <td
                  colSpan={draft.columns.length + 2}
                  className="text-center text-xs text-muted-foreground py-8"
                >
                  Нет строк. Нажмите «Вариант», чтобы добавить значение.
                </td>
              </tr>
            )}
            {draft.rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-muted/30">
                <td className="border-b border-r p-1 text-center text-[10px] text-muted-foreground">
                  {rowIdx + 1}
                </td>
                {draft.columns.map((col, colIdx) => {
                  const inSyncGroup = draft.syncGroups.some((g) =>
                    g.fieldIds.includes(col.fieldId),
                  );
                  const cellKey = `${rowIdx}-${colIdx}`;
                  const cellValue = row[colIdx] || "";
                  const isCellSelected = selectedCells.has(cellKey);
                  return (
                    <td
                      key={col.fieldId}
                      className={`border-b border-r p-0.5 ${
                        inSyncGroup ? "bg-blue-50/30" : ""
                      } ${cellSyncMode && isCellSelected ? "bg-green-100 dark:bg-green-900/40" : ""}`}
                    >
                      {cellSyncMode && cellValue.trim() ? (
                        <button
                          onClick={() => toggleCell(rowIdx, colIdx)}
                          className="w-full h-6 px-1 text-xs flex items-center gap-1 text-left hover:bg-accent rounded-sm"
                        >
                          <span className={`h-3.5 w-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                            isCellSelected
                              ? "bg-green-600 border-green-600 text-white"
                              : "border-input bg-background"
                          }`}>
                            {isCellSelected && <Check className="h-2.5 w-2.5" />}
                          </span>
                          <span className="truncate">{cellValue}</span>
                        </button>
                      ) : cellSyncMode ? (
                        <div className="w-full h-6 px-1 text-xs text-muted-foreground/40 flex items-center">—</div>
                      ) : (
                        <input
                          type="text"
                          value={cellValue}
                          onChange={(e) => updateCell(rowIdx, colIdx, e.target.value)}
                          disabled={formulaLinkedFieldIds.has(col.fieldId)}
                          className="w-full h-6 px-1 text-xs bg-transparent outline-none focus:bg-background focus:ring-1 focus:ring-primary rounded-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-muted/50"
                          placeholder="—"
                          title={formulaLinkedFieldIds.has(col.fieldId) ? "Вычисляется формулой — нельзя изменить" : undefined}
                        />
                      )}
                    </td>
                  );
                })}
                <td className="border-b p-1 text-center">
                  <button
                    onClick={() => removeRow(rowIdx)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Удалить строку"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DialogFooter className="border-t pt-3">
        <div className="flex items-center gap-3 mr-auto text-xs text-muted-foreground">
          <span>{draft.columns.length} полей</span>
          <span>{draft.rows.length} вариантов</span>
          <span>{draft.syncGroups.length} групп синхр.</span>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button onClick={handleSave} className="gap-1.5">
          <Check className="h-4 w-4" />
          Сохранить
        </Button>
      </DialogFooter>
    </div>
  );
}
