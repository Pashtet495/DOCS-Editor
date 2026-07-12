"use client";

/**
 * FormulaLinkDialog — modal for linking a table cell to a calculator formula
 * or constant (the "f" button in the table toolbar).
 *
 * Features:
 *  - Lists all FormulaEntry items from the calculator's FormulaStore, split
 *    into two sections: "Константы" (constants) and "Функции" (functions).
 *    Each row shows: name, formula, comment, value.
 *  - Default cell coordinate = the currently selected cell (pre-filled). The
 *    user can pick a different cell via the grid (pick mode) or type a coord.
 *  - If the user selects a CONSTANT → the dialog closes immediately and the
 *    link is created (simple scenario).
 *  - If the user selects a FUNCTION → a dependency panel appears listing ALL
 *    transitive dependencies (e.g. root → discriminant → a, b, c). Each
 *    dependency gets its own cell-coordinate input (default: empty cells
 *    below the selected one). The user can adjust each coordinate and then
 *    create links for the function + all selected dependencies.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Crosshair,
  Check,
  X,
  FunctionSquare,
  Sigma,
  Hash,
  Link2,
  ChevronRight,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  toCellRef,
  parseCellRef,
  letterToCol,
} from "@/lib/table/cell-utils";
import {
  classifyFormula,
  getDependencies,
  formatFormulaValue,
  isMatrixFormula,
  findEmptyCellsBelow,
} from "@/lib/table/calc-engine";
import type { FormulaEntry } from "@/lib/editor/types";
import type { Cell } from "@/lib/table/types";

export interface FormulaLinkDialogProps {
  open: boolean;
  /** When true, the dialog shrinks to a "pick cell" bar for coordinate selection. */
  picking: boolean;
  /** Currently picked cell (controlled by parent). */
  pickedCell: { row: number; col: number } | null;
  /** Initial coordinate text (pre-filled when dialog opens). */
  initialCoord?: string;
  /** Called when the user clicks "Pick cell" or "Done". */
  onPickingChange: (p: boolean) => void;
  /** The calculator's formula store entries (constants + functions). */
  formulas: FormulaEntry[];
  /** The current table cells (for finding empty cells below the selection). */
  tableCells: (Cell | null)[][];
  /** Called when the user confirms a CONSTANT link (simple scenario).
   *  Receives the cell coord and the formula ID. */
  onLinkConstant: (
    cell: { row: number; col: number },
    formulaId: string,
  ) => void;
  /** Called when the user confirms a FUNCTION link with dependencies.
   *  Receives the function's cell coord, the formula ID, and an array of
   *  { formulaId, cell } pairs for each dependency to link. */
  onLinkFunction: (
    cell: { row: number; col: number },
    formulaId: string,
    dependencies: Array<{ formulaId: string; cell: { row: number; col: number } }>,
  ) => void;
  /** Called when the dialog is closed. */
  onClose: () => void;
}

export function FormulaLinkDialog(props: FormulaLinkDialogProps) {
  const {
    open,
    picking,
    pickedCell,
    initialCoord,
    onPickingChange,
    formulas,
    tableCells,
    onLinkConstant,
    onLinkFunction,
    onClose,
  } = props;

  const [coordText, setCoordText] = useState("");
  /** The currently selected formula (for the dependency panel). */
  const [selectedFormula, setSelectedFormula] = useState<FormulaEntry | null>(null);
  /** Dependency coords: formulaId → coord string. */
  const [depCoords, setDepCoords] = useState<Record<string, string>>({});
  /** Which dependency is currently being picked (for pick mode). */
  const [pickingForDep, setPickingForDep] = useState<string | null>(null);

  // Reset state ONLY when the dialog opens (open: false → true).
  // Using a ref to track the previous open value prevents the reset from
  // firing on every parent re-render (which would wipe the user's input
  // if initialCoord gets a new reference).
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setCoordText(initialCoord || "");
      setSelectedFormula(null);
      setDepCoords({});
      setPickingForDep(null);
    }
    prevOpenRef.current = open;
  }, [open, initialCoord]);

  // Keep coordText in sync with pickedCell (when in main pick mode).
  useEffect(() => {
    if (pickedCell && !pickingForDep) {
      setCoordText(toCellRef(pickedCell.row, pickedCell.col));
    }
  }, [pickedCell, pickingForDep]);

  // When pickingForDep is set, update that dependency's coord.
  useEffect(() => {
    if (pickedCell && pickingForDep) {
      setDepCoords((prev) => ({
        ...prev,
        [pickingForDep]: toCellRef(pickedCell.row, pickedCell.col),
      }));
      setPickingForDep(null);
      onPickingChange(false);
    }
  }, [pickedCell, pickingForDep, onPickingChange]);

  // Escape exits pick mode.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onPickingChange(false);
        setPickingForDep(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picking, onPickingChange]);

  // Split formulas into constants and functions.
  const { constants, functions } = useMemo(() => {
    const c: FormulaEntry[] = [];
    const f: FormulaEntry[] = [];
    for (const fe of formulas) {
      if (isMatrixFormula(fe.formula)) {
        // Matrix/vector constants go in the constants section.
        c.push(fe);
      } else if (classifyFormula(fe) === "function") {
        f.push(fe);
      } else {
        c.push(fe);
      }
    }
    return { constants: c, functions: f };
  }, [formulas]);

  // Parse the main coordinate.
  const mainCell = useMemo(() => {
    const trimmed = coordText.trim().toUpperCase();
    if (!trimmed) return null;
    const parsed = parseCellRef(trimmed);
    return parsed ? { row: parsed.row, col: parsed.col } : null;
  }, [coordText]);

  // When a function is selected, compute its dependencies + default coords.
  const dependencies = useMemo(() => {
    if (!selectedFormula) return [];
    return getDependencies(selectedFormula, formulas);
  }, [selectedFormula, formulas]);

  // Initialize default dependency coords ONLY when the selected formula or
  // mainCell changes. We deliberately exclude `tableCells` from deps because
  // the parent's draft.cells gets a new reference on every edit (including
  // background recalc), which would re-fire this effect and overwrite the
  // user's manually-typed coordinates.
  useEffect(() => {
    if (!selectedFormula || !mainCell) return;
    const empties = findEmptyCellsBelow(
      tableCells,
      mainCell.row,
      mainCell.col,
      dependencies.length,
    );
    const newCoords: Record<string, string> = {};
    dependencies.forEach((dep, i) => {
      const cell = empties[i] || { row: mainCell.row + 1 + i, col: mainCell.col };
      newCoords[dep.id] = toCellRef(cell.row, cell.col);
    });
    setDepCoords(newCoords);
  }, [selectedFormula, mainCell, dependencies]);

  // Handle selecting a constant → immediate link + close.
  const handleSelectConstant = (fe: FormulaEntry) => {
    if (!mainCell) return;
    onLinkConstant(mainCell, fe.id);
  };

  // Handle selecting a function → show dependency panel.
  const handleSelectFunction = (fe: FormulaEntry) => {
    setSelectedFormula(fe);
  };

  // Confirm function link with dependencies.
  const handleConfirmFunction = () => {
    if (!selectedFormula || !mainCell) return;
    const deps = dependencies
      .map((dep) => {
        const coord = depCoords[dep.id];
        if (!coord) return null;
        const parsed = parseCellRef(coord.trim().toUpperCase());
        if (!parsed) return null;
        return { formulaId: dep.id, cell: { row: parsed.row, col: parsed.col } };
      })
      .filter((d): d is { formulaId: string; cell: { row: number; col: number } } => d !== null);
    onLinkFunction(mainCell, selectedFormula.id, deps);
  };

  // Pick mode bar — for either the main cell or a dependency.
  if (picking && open) {
    const label = pickingForDep
      ? `Координата для «${formulas.find((f) => f.id === pickingForDep)?.name || ""}»`
      : "Координата ячейки для формулы";
    return (
      <div
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[10005] flex w-[460px] max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border bg-background p-3 shadow-xl"
        role="dialog"
        aria-label="Выбор ячейки"
      >
        <Crosshair className="h-4 w-4 text-primary flex-shrink-0" />
        <span className="text-sm font-medium flex-shrink-0">{label}:</span>
        <Input
          value={pickingForDep ? depCoords[pickingForDep] || "" : coordText}
          onChange={(e) => {
            if (pickingForDep) {
              setDepCoords((prev) => ({ ...prev, [pickingForDep]: e.target.value }));
            } else {
              setCoordText(e.target.value);
            }
          }}
          className="h-8 flex-1 font-mono"
          placeholder="A1"
          autoFocus
        />
        <Button
          type="button"
          size="sm"
          className="h-8"
          onClick={() => {
            onPickingChange(false);
            setPickingForDep(null);
          }}
        >
          <Check className="h-4 w-4" />
          Готово
        </Button>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl" style={{ zIndex: 10005 }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FunctionSquare className="h-4 w-4 text-[#991b1b]" />
            Связать ячейку с формулой калькулятора
          </DialogTitle>
          <DialogDescription>
            Выберите константу или функцию из калькулятора для синхронизации
            со значением ячейки. Константы связываются сразу; для функций
            будут предложены зависимые переменные.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          {/* Coordinate input */}
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="fl-coord" className="text-xs">
                Координата ячейки
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="fl-coord"
                  value={coordText}
                  onChange={(e) => setCoordText(e.target.value)}
                  className="font-mono h-9"
                  placeholder="A1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={() => {
                    setPickingForDep(null);
                    onPickingChange(true);
                  }}
                  title="Выбрать ячейку в таблице"
                >
                  <Crosshair className="h-4 w-4" />
                  Выбрать
                </Button>
              </div>
            </div>
            {mainCell && (
              <Badge variant="outline" className="mb-1">
                {toCellRef(mainCell.row, mainCell.col)}
              </Badge>
            )}
          </div>

          {/* Dependency panel (shown when a function is selected) */}
          {selectedFormula && (
            <div className="rounded-md border border-[#fecaca] bg-[#fef2f2] p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Sigma className="h-4 w-4 text-[#991b1b]" />
                  <span className="text-sm font-medium">
                    Функция: <span className="font-mono">{selectedFormula.name}</span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFormula(null);
                    setDepCoords({});
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="text-xs text-muted-foreground mb-2 font-mono bg-white/60 rounded px-2 py-1">
                {selectedFormula.formula}
              </div>
              {dependencies.length > 0 ? (
                <>
                  <div className="flex items-center gap-1.5 text-xs font-medium text-[#991b1b] mb-1.5">
                    <Info className="h-3 w-3" />
                    Зависимости ({dependencies.length}) — свяжите с ячейками:
                  </div>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {dependencies.map((dep) => (
                      <div key={dep.id} className="flex items-center gap-2">
                        <span className="font-mono text-xs w-16 flex-shrink-0 font-medium">
                          {dep.name}
                        </span>
                        <span className="text-xs text-muted-foreground flex-1 truncate">
                          {dep.formula}
                        </span>
                        <Input
                          value={depCoords[dep.id] || ""}
                          onChange={(e) =>
                            setDepCoords((prev) => ({
                              ...prev,
                              [dep.id]: e.target.value,
                            }))
                          }
                          className="font-mono h-7 w-24 text-xs"
                          placeholder="A1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => {
                            setPickingForDep(dep.id);
                            onPickingChange(true);
                          }}
                          title="Выбрать ячейку"
                        >
                          <Crosshair className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-xs text-muted-foreground">
                  Нет зависимостей — функция использует только встроенные
                  операции.
                </div>
              )}
              <div className="flex justify-end mt-3">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleConfirmFunction}
                  disabled={!mainCell}
                  className="bg-[#991b1b] hover:bg-[#7f1d1d] text-white"
                >
                  <Link2 className="h-4 w-4" />
                  Создать связи
                </Button>
              </div>
            </div>
          )}

          {/* Formula lists — hidden when a function is being configured */}
          {!selectedFormula && (
            <div className="flex flex-col gap-3">
              {/* Constants section */}
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1.5">
                  <Hash className="h-3 w-3" />
                  Константы ({constants.length})
                </div>
                <ScrollArea className="h-40 rounded-md border">
                  {constants.length === 0 ? (
                    <div className="p-3 text-xs text-muted-foreground text-center">
                      Нет констант. Создайте их через кнопку «f+» или в калькуляторе.
                    </div>
                  ) : (
                    <div className="divide-y">
                      {constants.map((fe) => (
                        <FormulaRow
                          key={fe.id}
                          entry={fe}
                          onSelect={() => handleSelectConstant(fe)}
                          disabled={!mainCell}
                        />
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>

              {/* Functions section */}
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1.5">
                  <Sigma className="h-3 w-3" />
                  Функции ({functions.length})
                </div>
                <ScrollArea className="h-40 rounded-md border">
                  {functions.length === 0 ? (
                    <div className="p-3 text-xs text-muted-foreground text-center">
                      Нет функций.
                    </div>
                  ) : (
                    <div className="divide-y">
                      {functions.map((fe) => (
                        <FormulaRow
                          key={fe.id}
                          entry={fe}
                          onSelect={() => handleSelectFunction(fe)}
                          disabled={!mainCell}
                          isFunction
                        />
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end items-center pt-1">
          <Button variant="outline" onClick={onClose}>
            <X className="h-4 w-4" />
            Закрыть
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// FormulaRow — a single formula entry in the list.
// ---------------------------------------------------------------------------

interface FormulaRowProps {
  entry: FormulaEntry;
  onSelect: () => void;
  disabled?: boolean;
  isFunction?: boolean;
}

function FormulaRow({ entry, onSelect, disabled, isFunction }: FormulaRowProps) {
  const isMatrix = isMatrixFormula(entry.formula);
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      <span className="font-mono text-sm font-medium w-16 flex-shrink-0 text-[#991b1b]">
        {entry.name}
      </span>
      <span className="font-mono text-xs flex-1 truncate text-foreground">
        {entry.formula}
      </span>
      {entry.comment && (
        <span className="text-xs text-muted-foreground truncate max-w-[120px]">
          {entry.comment}
        </span>
      )}
      <Badge
        variant="outline"
        className="font-mono text-xs flex-shrink-0"
      >
        {isMatrix ? "матрица" : formatFormulaValue(entry)}
      </Badge>
      {isFunction && (
        <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      )}
    </button>
  );
}
