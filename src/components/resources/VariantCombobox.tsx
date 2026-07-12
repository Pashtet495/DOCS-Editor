"use client";

import { useState, useMemo } from "react";
import { Check, ChevronsUpDown, Search, Link2, X, ListChecks } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import {
  getFieldInstances,
  getActiveSuffix,
  getInstanceValue,
  getSyncedValues,
  type AutoFillField,
  type AutoFillSyncGroup,
  type AutoFillStore,
} from "@/lib/editor/autofill-types";

/**
 * VariantCombobox
 *
 * A searchable dropdown for selecting an auto-fill field's variant value.
 *
 * Features:
 *  - Search filtering (handles hundreds of variants).
 *  - LIST sync support: if the field is in a sync group, and ANOTHER field in
 *    the group has a selected value with a mapping to this field, the mapped
 *    LIST of values is shown in a separate "Связанные значения" group with 🔗.
 *    Selecting a synced value is just a normal selection (no auto-propagation
 *    — the source field's selection drives what appears here).
 *  - Sync setup mode: supports multi-select (draft values). Each selected
 *    draft value shows a ✓. Used when configuring sync rules.
 */

interface VariantComboboxProps {
  field: AutoFillField;
  store: AutoFillStore;
  /** The currently selected value (for display) of the ACTIVE instance. */
  selectedValue: string | null;
  /** Called when a value is selected (normal mode). */
  onSelect: (value: string) => void;
  /** Draft values during sync setup (array). */
  draftValues?: string[];
  /** Called when a draft value is toggled (sync setup mode). */
  onDraftToggle?: (value: string) => void;
  /** Placeholder text. */
  placeholder?: string;
  /** Compact mode (smaller height). */
  compact?: boolean;
  /** Disabled state. */
  disabled?: boolean;
  /** Filter mode: "all" = show all variants, "sync" = show ONLY synced values
   *  (when synced values exist and at least one field has a selection). */
  filterMode?: "all" | "sync";
}

export function VariantCombobox({
  field,
  store,
  selectedValue,
  onSelect,
  draftValues,
  onDraftToggle,
  placeholder = "Выбрать значение…",
  compact = false,
  disabled = false,
  filterMode = "all",
}: VariantComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const isSyncMode = draftValues !== undefined && onDraftToggle !== undefined;

  // Find the sync group for this field (if any)
  const syncGroup = useMemo(
    () => store.syncGroups.find((g) => g.id === field.syncGroupId),
    [store.syncGroups, field.syncGroupId],
  );

  // Compute the synced values LIST for this field.
  // IMPORTANT: only considers the ACTIVE instance of each other field — so
  // if the user is editing AF001_1, syncs come from AF001_1's value, not AF001.
  const syncedValues = (() => {
    if (!syncGroup) return [];
    const result = new Set<string>();
    for (const otherFieldId of syncGroup.fieldIds) {
      if (otherFieldId === field.id) continue;
      const otherField = store.fields.find((f) => f.id === otherFieldId);
      if (!otherField) continue;
      const activeSuffix = getActiveSuffix(store, otherFieldId);
      const activeVal = getInstanceValue(otherField, activeSuffix);
      if (activeVal) {
        const vals = getSyncedValues(syncGroup, otherFieldId, activeVal, field.id);
        for (const v of vals) result.add(v);
      }
    }
    return Array.from(result);
  })();

  // Check if any other field's ACTIVE instance has a selection (for filter mode)
  const hasAnySelection = (() => {
    if (!syncGroup) return false;
    return syncGroup.fieldIds.some((fid) => {
      if (fid === field.id) return false;
      const f = store.fields.find((ff) => ff.id === fid);
      if (!f) return false;
      const activeSuffix = getActiveSuffix(store, fid);
      return getInstanceValue(f, activeSuffix) != null;
    });
  })();

  // Build the options list
  const allOptions = useMemo(() => {
    return field.variants.map((value) => ({
      label: value,
      value,
      isSynced: syncedValues.includes(value),
    }));
  }, [field.variants, syncedValues]);

  // In "sync" filter mode: if there are synced values AND at least one other
  // field has a selection, show ONLY the synced values. Otherwise show all.
  const filterToSynced = filterMode === "sync" && syncedValues.length > 0 && hasAnySelection;

  // Filter by search, then apply sync filter if active
  const filtered = useMemo(() => {
    let opts = allOptions;
    // In sync filter mode, restrict to ONLY synced values
    if (filterToSynced) {
      opts = opts.filter((o) => o.isSynced);
    }
    if (!search.trim()) return opts;
    const q = search.toLowerCase();
    return opts.filter((o) => o.label.toLowerCase().includes(q));
  }, [allOptions, search, filterToSynced]);

  // When filterToSynced is active, all options are "synced" — put them all
  // in the synced group with the link icon.
  const syncedOptions = filterToSynced ? filtered : filtered.filter((o) => o.isSynced);
  const plainOptions = filterToSynced ? [] : filtered.filter((o) => !o.isSynced);

  // Display value
  const displayValue = isSyncMode
    ? (draftValues && draftValues.length > 0 ? `${draftValues.length} выбрано` : null)
    : selectedValue;

  const handleSelect = (value: string) => {
    if (isSyncMode) {
      onDraftToggle?.(value);
    } else {
      onSelect(value);
      setOpen(false);
    }
    setSearch("");
  };

  // Check if a value is in the draft (for multi-select ✓)
  const isDrafted = (value: string) => draftValues?.includes(value) ?? false;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? `variant-listbox-${field.id}` : undefined}
          aria-haspopup="listbox"
          disabled={disabled}
          className={cn(
            "flex w-full items-center justify-between gap-1 rounded-md border border-input bg-background px-2 text-left text-xs shadow-sm transition-colors",
            "hover:bg-accent hover:text-accent-foreground",
            "focus:outline-none focus:ring-1 focus:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            compact ? "h-6" : "h-7",
          )}
        >
          <span className={cn("truncate flex-1", !displayValue && "text-muted-foreground")}>
            {displayValue || placeholder}
          </span>
          {selectedValue && !isSyncMode && syncGroup && syncedValues.includes(selectedValue) && (
            <Link2 className="h-3 w-3 text-blue-500 shrink-0" />
          )}
          {isSyncMode && draftValues && draftValues.length > 0 && (
            <ListChecks className="h-3 w-3 text-green-600 shrink-0" />
          )}
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[240px] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <div className="flex items-center border-b px-2">
            <Search className="mr-1 h-3.5 w-3.5 shrink-0 opacity-50" />
            <CommandInput
              placeholder="Поиск…"
              value={search}
              onValueChange={setSearch}
              className="h-8 text-xs"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="ml-1 rounded p-0.5 hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <CommandList className="max-h-[280px]">
            <CommandEmpty>Ничего не найдено</CommandEmpty>
            {isSyncMode && (
              <div className="px-2 py-1 text-[10px] text-muted-foreground border-b bg-muted/30">
                {isSyncMode ? "Множественный выбор — нажмите значения для связи" : ""}
              </div>
            )}
            {syncedOptions.length > 0 && (
              <>
                <CommandGroup heading="Связанные значения" className="text-xs">
                  {syncedOptions.map((option) => (
                    <CommandItem
                      key={`sync-${option.value}`}
                      value={`sync-${option.value}`}
                      onSelect={() => handleSelect(option.value)}
                      className="gap-1.5 text-xs"
                    >
                      <Link2 className="h-3 w-3 text-blue-500 shrink-0" />
                      <span className="flex-1 truncate">{option.label}</span>
                      {isSyncMode && isDrafted(option.value) && (
                        <Check className="h-3 w-3 text-green-600" />
                      )}
                      {!isSyncMode && selectedValue === option.value && (
                        <Check className="h-3 w-3 text-primary" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup heading="Значения" className="text-xs">
              {plainOptions.map((option) => (
                <CommandItem
                  key={`plain-${option.value}`}
                  value={`plain-${option.value}`}
                  onSelect={() => handleSelect(option.value)}
                  className="gap-1.5 text-xs"
                >
                  <span className="w-3" />
                  <span className="flex-1 truncate">{option.label}</span>
                  {isSyncMode && isDrafted(option.value) && (
                    <Check className="h-3 w-3 text-green-600" />
                  )}
                  {!isSyncMode && selectedValue === option.value && (
                    <Check className="h-3 w-3 text-primary" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
