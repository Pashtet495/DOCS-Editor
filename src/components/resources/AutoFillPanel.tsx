"use client";

import { useState, useCallback, useMemo } from "react";
import {
  ChevronDown, ChevronUp, Plus, Trash2, Edit3, X,
  Link2, Check, Table2, FileText, AlertCircle, Info,
  ChevronLeft, ChevronRight, Link as LinkIcon,
} from "lucide-react";
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
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useEditorStore } from "@/store/editor-store";
import {
  getFieldInstances,
  getActiveSuffix,
  getInstanceValue,
  makeMarkerForInstance,
  type AutoFillField,
} from "@/lib/editor/autofill-types";
import { VariantCombobox } from "./VariantCombobox";

export function AutoFillPanel() {
  const autoFillStore = useEditorStore((s) => s.autoFillStore);
  const syncMode = useEditorStore((s) => s.autoFillSyncMode);
  const syncDraft = useEditorStore((s) => s.autoFillSyncDraft);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newReplaceText, setNewReplaceText] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const draftFieldCount = Object.keys(syncDraft).filter((k) => syncDraft[k].length > 0).length;
  const draftTotalCount = Object.values(syncDraft).reduce((sum, arr) => sum + arr.length, 0);

  if (!autoFillStore) return null;

  const fields = autoFillStore.fields;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border rounded-lg">
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center justify-between rounded-lg bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/50 border">
          <span className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Автозаполнение ({fields.length} полей)
            {syncMode && (
              <Badge variant="secondary" className="text-[9px] gap-0.5 animate-pulse">
                <Link2 className="h-2.5 w-2.5" />
                настройка связи
              </Badge>
            )}
          </span>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="p-3 space-y-3">
        {/* Toolbar */}
        <div className="flex gap-1 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 border"
            onClick={() => setShowCreateForm(!showCreateForm)}
            disabled={syncMode}
          >
            <Plus className="h-3 w-3" /> Создать поле
          </Button>

          {syncMode ? (
            <>
              <Button
                size="sm"
                variant="default"
                className="h-7 text-xs gap-1"
                onClick={() => useEditorStore.getState().saveAutoFillSyncMappings()}
                disabled={draftFieldCount < 2}
                title={draftFieldCount < 2 ? "Выберите ≥2 поля" : "Сохранить правило"}
              >
                <Check className="h-3 w-3" />
                Сохранить ({draftFieldCount} поля, {draftTotalCount} знач.)
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1 border"
                onClick={() => useEditorStore.getState().cancelAutoFillSyncMode()}
              >
                <X className="h-3 w-3" /> Отмена
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1 border"
              onClick={() => useEditorStore.getState().startAutoFillSyncMode()}
              title="Настроить синхронизацию между полями (списочные связи)"
            >
              <Link2 className="h-3 w-3" /> Синхр.
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 border"
            onClick={() => useEditorStore.getState().setAutoFillXmlEditorOpen(true)}
            disabled={syncMode}
          >
            <Table2 className="h-3 w-3" /> Таблица
          </Button>
          <Select
            value={autoFillStore.variantFilter}
            onValueChange={(v) => useEditorStore.getState().setAutoFillVariantFilter(v as "all" | "single" | "sync")}
          >
            <SelectTrigger className="h-7 text-xs w-24 border"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              <SelectItem value="single">Единичные</SelectItem>
              <SelectItem value="sync">Синхр.</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Sync mode banner */}
        {syncMode && (
          <div className="flex items-start gap-2 rounded-md border border-blue-300 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-700 px-3 py-2 text-xs">
            <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-medium text-blue-900 dark:text-blue-200">
                Настройка списочной синхронизации
              </div>
              <div className="text-blue-700 dark:text-blue-300">
                Выберите значения в карточках (можно несколько в каждой). Например:
                Тип=«Труба», Сортамент=[20х10, 20х20], Длина=[500мм, 1000мм].
                После сохранения при выборе «Труба» в Сортаменте появятся связанные 20х10, 20х20.
              </div>
              {draftFieldCount < 2 && (
                <div className="text-blue-600 dark:text-blue-400 flex items-center gap-1 pt-0.5">
                  <AlertCircle className="h-3 w-3" />
                  Нужно выбрать минимум 2 поля ({draftFieldCount}/2)
                </div>
              )}
              {draftFieldCount >= 2 && (
                <div className="text-green-700 dark:text-green-400 flex items-center gap-1 pt-0.5 font-medium">
                  <Check className="h-3 w-3" />
                  Готово к сохранению ({draftTotalCount} знач. в {draftFieldCount} полях)
                </div>
              )}
            </div>
          </div>
        )}

        {/* Existing sync groups (editable) */}
        {!syncMode && autoFillStore.syncGroups.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground font-medium">Существующие связи:</div>
            {autoFillStore.syncGroups.map((g) => {
              const mappingCount = Object.keys(g.mappings).length;
              const fieldLabels = g.fieldIds.map((fid) => autoFillStore.fields.find((f) => f.id === fid)?.label || fid);
              return (
                <div key={g.id} className="flex items-center gap-1.5 rounded border bg-muted/20 px-2 py-1 text-[10px]">
                  <LinkIcon className="h-3 w-3 text-blue-500 shrink-0" />
                  <span className="truncate flex-1">{fieldLabels.join(" ⇄ ")}</span>
                  <Badge variant="outline" className="text-[9px] px-1">{mappingCount} пр.</Badge>
                  <button
                    onClick={() => useEditorStore.getState().deleteAutoFillSyncGroup(g.id)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Удалить связь"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Create field form */}
        {showCreateForm && !syncMode && (
          <div className="space-y-2 border rounded p-2 bg-muted/20">
            <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Название поля" className="h-7 text-xs" />
            <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Описание (для ИИ)" className="h-7 text-xs" />
            <Input value={newReplaceText} onChange={(e) => setNewReplaceText(e.target.value)} placeholder="Текст для замены (пусто = только метка)" className="h-7 text-xs" />
            <div className="flex gap-1">
              <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => {
                useEditorStore.getState().createAutoFillField(newLabel, newDesc, newReplaceText || undefined);
                setNewLabel(""); setNewDesc(""); setNewReplaceText(""); setShowCreateForm(false);
              }}>Создать</Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowCreateForm(false)}>Отмена</Button>
            </div>
          </div>
        )}

        {/* Field cards — filtered by variantFilter */}
        <div className="max-h-64 overflow-y-auto space-y-1">
          {fields.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-4">
              Нет полей. Создайте поле для автозаполнения.
            </div>
          )}
          {fields
            .filter((field) => {
              if (autoFillStore.variantFilter === "single") return !field.syncGroupId;
              if (autoFillStore.variantFilter === "sync") return !!field.syncGroupId;
              return true;
            })
            .map((field) => (
            <AutoFillFieldCard
              key={field.id}
              field={field}
              store={autoFillStore}
              syncMode={syncMode}
              syncDraft={syncDraft}
              filterMode={autoFillStore.variantFilter === "sync" ? "sync" : "all"}
              editing={editingId === field.id}
              onEdit={() => { setEditingId(field.id); setNewLabel(field.label); setNewDesc(field.description); }}
              onCancelEdit={() => { setEditingId(null); setNewLabel(""); setNewDesc(""); }}
              newLabel={newLabel}
              newDesc={newDesc}
              onNewLabel={setNewLabel}
              onNewDesc={setNewDesc}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface AutoFillFieldCardProps {
  field: AutoFillField;
  store: ReturnType<typeof useEditorStore.getState>["autoFillStore"];
  syncMode: boolean;
  syncDraft: Record<string, string[]>;
  filterMode: "all" | "sync";
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  newLabel: string;
  newDesc: string;
  onNewLabel: (v: string) => void;
  onNewDesc: (v: string) => void;
}

function AutoFillFieldCard({
  field, store, syncMode, syncDraft, filterMode, editing, onEdit, onCancelEdit,
  newLabel, newDesc, onNewLabel, onNewDesc,
}: AutoFillFieldCardProps) {
  const updateAutoFillField = useEditorStore((s) => s.updateAutoFillField);
  const deleteAutoFillField = useEditorStore((s) => s.deleteAutoFillField);
  const addAutoFillVariant = useEditorStore((s) => s.addAutoFillVariant);
  const setAutoFillValue = useEditorStore((s) => s.setAutoFillValue);
  const setAutoFillSyncDraftValue = useEditorStore((s) => s.setAutoFillSyncDraftValue);
  const clearAutoFillSyncDraft = useEditorStore((s) => s.clearAutoFillSyncDraft);
  const insertAutoFillInstanceMarker = useEditorStore((s) => s.insertAutoFillInstanceMarker);
  const createAutoFillInstance = useEditorStore((s) => s.createAutoFillInstance);
  const deleteAutoFillInstance = useEditorStore((s) => s.deleteAutoFillInstance);
  const setActiveAutoFillInstance = useEditorStore((s) => s.setActiveAutoFillInstance);
  const setAutoFillInstanceValue = useEditorStore((s) => s.setAutoFillInstanceValue);
  const [newVariant, setNewVariant] = useState("");

  const isSynced = !!field.syncGroupId;
  const instances = getFieldInstances(field);
  const activeSuffix = getActiveSuffix(store, field.id);
  const activeValue = getInstanceValue(field, activeSuffix);
  const hasDraft = syncDraft[field.id] && syncDraft[field.id].length > 0;
  const draftCount = syncDraft[field.id]?.length || 0;

  // Check if this AF field is linked to a table cell
  const tableDocs = useEditorStore((s) => s.tableDocs);
  const cellLink = (() => {
    for (const t of tableDocs) {
      const link = t.cellLinks.find((l) => l.autoFillFieldId === field.id);
      if (link) return { link, tableName: t.name };
    }
    return null;
  })();
  const isTableLinked = !!cellLink;

  // Border color logic
  const borderColor = syncMode
    ? (hasDraft ? "border-l-4 border-l-green-500" : "border-l-4 border-l-red-500")
    : isSynced ? "border-l-4 border-l-blue-400" : "";

  const handleSelect = useCallback((value: string) => {
    if (syncMode) {
      setAutoFillSyncDraftValue(field.id, value);
    } else if (activeSuffix === "") {
      setAutoFillValue(field.id, value, false);
    } else {
      setAutoFillInstanceValue(field.id, activeSuffix, value);
    }
  }, [syncMode, field.id, activeSuffix, setAutoFillSyncDraftValue, setAutoFillValue, setAutoFillInstanceValue]);

  return (
    <div className={`rounded border p-1.5 text-xs bg-muted/20 ${borderColor}`}>
      {editing ? (
        <div className="space-y-1">
          <Input value={newLabel} onChange={(e) => onNewLabel(e.target.value)} placeholder="Название" className="h-6 text-xs" />
          <Input value={newDesc} onChange={(e) => onNewDesc(e.target.value)} placeholder="Описание" className="h-6 text-xs" />
          <div className="flex gap-1">
            <Button size="sm" className="flex-1 h-6 text-xs" onClick={() => {
              updateAutoFillField(field.id, { label: newLabel, description: newDesc });
              onCancelEdit();
            }}>Сохранить</Button>
            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={onCancelEdit}>Отмена</Button>
          </div>
        </div>
      ) : (
        <>
          {/* Row 1: field ID + label + badges + action buttons */}
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1 min-w-0">
              <span className="font-mono text-[10px] text-muted-foreground">{field.id}</span>
              <span className="font-medium truncate">{field.label}</span>
              {isSynced && <Badge variant="outline" className="text-[8px] px-1 gap-0.5"><Link2 className="h-2 w-2" />синхр</Badge>}
              {isTableLinked && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center" title={`Синхронизировано с таблицей: ${cellLink!.tableName}`}>
                        <Link2 className="h-3 w-3 text-blue-500" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="text-xs">
                        <div className="font-medium">Синхронизировано с внешним ресурсом</div>
                        <div>Таблица: {cellLink!.tableName}</div>
                        <div>Метка: {cellLink!.link.label}</div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {syncMode && hasDraft && (
                <Badge variant="secondary" className="text-[8px] px-1 bg-green-100 text-green-700">
                  ✓ {draftCount}
                </Badge>
              )}
              {!syncMode && activeValue && (
                <Badge variant="secondary" className="text-[8px] px-1">✓</Badge>
              )}
            </div>
            <div className="flex gap-0.5 flex-shrink-0">
              <button onClick={onEdit} className="border rounded p-0.5 hover:bg-muted" title="Редактировать" disabled={syncMode}><Edit3 className="h-3 w-3" /></button>
              {/* Insert active instance marker into document */}
              <button
                onClick={() => insertAutoFillInstanceMarker(field.id, activeSuffix)}
                className="border rounded p-0.5 hover:bg-muted"
                title={`Вставить ${makeMarkerForInstance(field.id, activeSuffix)} в документ`}
                disabled={syncMode}
              >
                <Plus className="h-3 w-3" />
              </button>
              <button onClick={() => deleteAutoFillField(field.id)} className="border rounded p-0.5 hover:bg-muted text-destructive" title="Удалить поле" disabled={syncMode}><X className="h-3 w-3" /></button>
            </div>
          </div>

          {/* Row 2: Instance selector — ◀ "value | AF001_N" ▶ (or + at max) ✕ */}
          {!syncMode && (
            <div className="flex items-center gap-0.5 mt-1">
              {/* ◀ Previous — disabled when at primary instance */}
              <button
                onClick={() => {
                  const idx = instances.findIndex((i) => i.suffix === activeSuffix);
                  if (idx > 0) {
                    setActiveAutoFillInstance(field.id, instances[idx - 1].suffix);
                  }
                }}
                disabled={activeSuffix === "" || instances.length <= 1}
                className="border rounded p-0.5 hover:bg-muted flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Предыдущая вставка"
              >
                <ChevronLeft className="h-3 w-3" />
              </button>

              {/* Instance display + dropdown selector */}
              <Select
                value={activeSuffix === "" ? "__primary__" : activeSuffix}
                onValueChange={(v) => setActiveAutoFillInstance(field.id, v === "__primary__" ? "" : v)}
              >
                <SelectTrigger className="h-5 text-[10px] flex-1 border min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {instances.map((inst) => {
                    const fullId = `${field.id}${inst.suffix}`;
                    const val = inst.selectedValue || "—";
                    return (
                      <SelectItem key={inst.suffix || "__primary__"} value={inst.suffix === "" ? "__primary__" : inst.suffix} className="text-[10px]">
                        {val} | {fullId}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>

              {/* ▶ Next OR + create new (when at max instance) */}
              {(() => {
                const idx = instances.findIndex((i) => i.suffix === activeSuffix);
                const isAtMax = idx === instances.length - 1;
                if (isAtMax) {
                  // At the last instance — show + to create a new one
                  return (
                    <button
                      onClick={() => createAutoFillInstance(field.id)}
                      className="border rounded p-0.5 hover:bg-primary hover:text-primary-foreground text-primary font-bold flex-shrink-0 flex items-center justify-center"
                      style={{ width: 18, height: 18, fontSize: 12 }}
                      title={`Создать новый экземпляр ({{${field.id}_${instances.length}}})`}
                    >
                      +
                    </button>
                  );
                }
                // Not at max — show ▶ to go next
                return (
                  <button
                    onClick={() => {
                      setActiveAutoFillInstance(field.id, instances[idx + 1].suffix);
                    }}
                    className="border rounded p-0.5 hover:bg-muted flex-shrink-0"
                    title="Следующая вставка"
                  >
                    <ChevronRight className="h-3 w-3" />
                  </button>
                );
              })()}

              {/* ✕ Delete instance (only for non-primary) */}
              {activeSuffix !== "" && (
                <button
                  onClick={() => deleteAutoFillInstance(field.id, activeSuffix)}
                  className="border rounded p-0.5 hover:bg-muted text-destructive flex-shrink-0"
                  title="Удалить эту вставку"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {field.description && <div className="text-[10px] text-muted-foreground mt-0.5">{field.description}</div>}

          {/* Variant selector — searchable combobox */}
          {field.variants.length > 0 && (
            <div className="mt-1">
              <VariantCombobox
                field={field}
                store={store}
                selectedValue={activeValue}
                onSelect={handleSelect}
                draftValues={syncMode ? (syncDraft[field.id] || []) : undefined}
                onDraftToggle={syncMode ? handleSelect : undefined}
                placeholder={syncMode ? "Выберите значения для связи…" : "Выбрать значение…"}
                compact
                disabled={editing}
                filterMode={filterMode}
              />
              {/* Clear draft button in sync mode */}
              {syncMode && hasDraft && (
                <button
                  onClick={() => clearAutoFillSyncDraft(field.id)}
                  className="mt-0.5 w-full text-[9px] text-muted-foreground hover:text-destructive"
                >
                  Очистить выбор ({draftCount})
                </button>
              )}
            </div>
          )}

          {/* Add variant */}
          {!syncMode && (
            <div className="flex gap-0.5 mt-1">
              <Input
                value={newVariant}
                onChange={(e) => setNewVariant(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newVariant.trim()) { addAutoFillVariant(field.id, newVariant.trim()); setNewVariant(""); } }}
                placeholder="Добавить вариант..."
                className="h-5 text-[10px]"
              />
              <button
                onClick={() => { if (newVariant.trim()) { addAutoFillVariant(field.id, newVariant.trim()); setNewVariant(""); } }}
                className="border rounded px-1 text-[10px] hover:bg-muted"
              >+</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
