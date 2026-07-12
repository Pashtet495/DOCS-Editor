"use client";

/**
 * FormulaCreateDialog — modal for creating new calculator formulas/constants
 * from the table editor (the "f+" button in the table toolbar).
 *
 * Features:
 *  - Type selector: Константа / Функция / Вектор / Матрица.
 *  - For constant/function: name + formula expression + comment.
 *  - For vector/matrix: name + comment + "use selected range" button. The
 *    range is serialized into a math.js matrix literal and the cells get a
 *    matrix link (auto-synced bidirectionally).
 *  - The formula field supports referencing existing constants/functions
 *    (free text — math.js resolves them at eval time).
 */

import React, { useEffect, useRef, useState } from "react";
import { Crosshair, Check, X, FunctionSquare, Plus, Grid3x3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toCellRef, parseCellRef, letterToCol } from "@/lib/table/cell-utils";

export type FormulaCreateType = "constant" | "function" | "vector" | "matrix";

export interface FormulaCreateDialogProps {
  open: boolean;
  /** When true, the dialog shrinks to a "pick range" bar. */
  picking: boolean;
  /** Currently picked range start (for matrix/vector selection). */
  pickedCell: { row: number; col: number } | null;
  /** The current selection range in the grid (for pre-filling matrix coords). */
  selectionRange: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  onPickingChange: (p: boolean) => void;
  /** Called when the user confirms creation. */
  onCreate: (opts: {
    name: string;
    formula?: string;
    comment?: string;
    matrixCells?: Array<{ row: number; col: number }>;
    type: FormulaCreateType;
  }) => void;
  onClose: () => void;
}

export function FormulaCreateDialog(props: FormulaCreateDialogProps) {
  const {
    open,
    picking,
    pickedCell,
    selectionRange,
    onPickingChange,
    onCreate,
    onClose,
  } = props;

  const [type, setType] = useState<FormulaCreateType>("constant");
  const [name, setName] = useState("");
  const [formula, setFormula] = useState("");
  const [comment, setComment] = useState("");
  const [rangeText, setRangeText] = useState("");

  // Track the previous `open` value so we only reset the form when the dialog
  // TRANSITIONS from closed to open — NOT on every selectionRange reference
  // change. Without this, any background store update that causes the parent
  // to re-render would create a new selectionRange object, re-fire this effect,
  // and wipe the user's in-progress input.
  const prevOpenRef = useRef(false);

  // Reset state ONLY when the dialog opens (open: false → true).
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setType("constant");
      setName("");
      setFormula("");
      setComment("");
      // Pre-fill the range from the current selection if it's a multi-cell range.
      if (selectionRange) {
        const { startRow, startCol, endRow, endCol } = selectionRange;
        const isMultiCell = startRow !== endRow || startCol !== endCol;
        if (isMultiCell) {
          setRangeText(
            `${toCellRef(startRow, startCol)}:${toCellRef(endRow, endCol)}`,
          );
          // Auto-switch to matrix type if a range is pre-filled.
          const rowCount = Math.abs(endRow - startRow) + 1;
          const colCount = Math.abs(endCol - startCol) + 1;
          setType(rowCount === 1 || colCount === 1 ? "vector" : "matrix");
        } else {
          setRangeText("");
        }
      } else {
        setRangeText("");
      }
    }
    prevOpenRef.current = open;
  }, [open, selectionRange]);

  // Keep rangeText in sync with pickedCell during pick mode (single cell pick).
  useEffect(() => {
    if (pickedCell && picking) {
      setRangeText(toCellRef(pickedCell.row, pickedCell.col));
    }
  }, [pickedCell, picking]);

  // Escape exits pick mode.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onPickingChange(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picking, onPickingChange]);

  const isNameValid = name.trim() && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim());
  const isFormulaType = type === "constant" || type === "function";
  const isMatrixType = type === "vector" || type === "matrix";

  const matrixCells = React.useMemo(() => {
    if (!isMatrixType || !rangeText.trim()) return [];
    const trimmed = rangeText.trim().toUpperCase();
    const rangeMatch = trimmed.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (rangeMatch) {
      const startCol = letterToCol(rangeMatch[1]);
      const startRow = parseInt(rangeMatch[2], 10) - 1;
      const endCol = letterToCol(rangeMatch[3]);
      const endRow = parseInt(rangeMatch[4], 10) - 1;
      const cells: Array<{ row: number; col: number }> = [];
      for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
        for (let c = Math.min(startCol, endCol); c <= Math.max(startCol, endCol); c++) {
          cells.push({ row: r, col: c });
        }
      }
      return cells;
    }
    // Single cell
    const single = parseCellRef(trimmed);
    return single ? [{ row: single.row, col: single.col }] : [];
  }, [isMatrixType, rangeText]);

  const canCreate =
    isNameValid &&
    ((isFormulaType && formula.trim()) || (isMatrixType && matrixCells.length > 0));

  const handleCreate = () => {
    if (!canCreate) return;
    onCreate({
      name: name.trim(),
      formula: isFormulaType ? formula.trim() : undefined,
      comment: comment.trim() || undefined,
      matrixCells: isMatrixType ? matrixCells : undefined,
      type,
    });
  };

  // Pick mode bar.
  if (picking && open) {
    return (
      <div
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[10005] flex w-[460px] max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border bg-background p-3 shadow-xl"
        role="dialog"
        aria-label="Выбор диапазона"
      >
        <Crosshair className="h-4 w-4 text-primary flex-shrink-0" />
        <span className="text-sm font-medium flex-shrink-0">Диапазон:</span>
        <Input
          value={rangeText}
          onChange={(e) => setRangeText(e.target.value)}
          className="h-8 flex-1 font-mono"
          placeholder="A1:B3"
          autoFocus
        />
        <Button
          type="button"
          size="sm"
          className="h-8"
          onClick={() => onPickingChange(false)}
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
      <DialogContent className="sm:max-w-md" style={{ zIndex: 10005 }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-[#991b1b]" />
            <FunctionSquare className="h-4 w-4 text-[#991b1b]" />
            Новая формула / константа
          </DialogTitle>
          <DialogDescription>
            Создаёт запись в калькуляторе. Константы и функции становятся
            глобальными переменными для всего документа, включая таблицы.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          {/* Type selector */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Тип</Label>
            <div className="grid grid-cols-4 gap-1.5">
              {([
                { value: "constant", label: "Константа" },
                { value: "function", label: "Функция" },
                { value: "vector", label: "Вектор" },
                { value: "matrix", label: "Матрица" },
              ] as Array<{ value: FormulaCreateType; label: string }>).map(
                (opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setType(opt.value)}
                    className={
                      "rounded-md border px-2 py-1.5 text-xs font-medium transition-colors " +
                      (type === opt.value
                        ? "border-[#991b1b] bg-[#fee2e2] text-[#991b1b]"
                        : "border-border bg-background hover:bg-accent")
                    }
                  >
                    {opt.label}
                  </button>
                ),
              )}
            </div>
          </div>

          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fc-name" className="text-xs">
              Имя (идентификатор)
            </Label>
            <Input
              id="fc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 font-mono"
              placeholder="Напр. a, D, M, x1"
              autoFocus
            />
            {name && !isNameValid && (
              <span className="text-xs text-destructive">
                Имя должно начинаться с буквы и содержать только латиницу, цифры и _
              </span>
            )}
          </div>

          {/* Formula (for constant/function) */}
          {isFormulaType && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fc-formula" className="text-xs">
                {type === "constant" ? "Значение" : "Формула"}
              </Label>
              <Textarea
                id="fc-formula"
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
                className="font-mono text-sm min-h-[60px]"
                placeholder={
                  type === "constant"
                    ? "Напр. 4, 3.14, sqrt(2)"
                    : "Напр. (-b + sqrt(D)) / (2*a)"
                }
              />
              <span className="text-xs text-muted-foreground">
                {type === "function"
                  ? "Можно использовать уже существующие константы и функции."
                  : "Число или выражение без ссылок на переменные."}
              </span>
            </div>
          )}

          {/* Range (for vector/matrix) */}
          {isMatrixType && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fc-range" className="text-xs">
                {type === "vector" ? "Диапазон вектора" : "Диапазон матрицы"}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="fc-range"
                  value={rangeText}
                  onChange={(e) => setRangeText(e.target.value)}
                  className="font-mono h-9"
                  placeholder="A1:B3"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={() => onPickingChange(true)}
                  title="Выбрать диапазон в таблице"
                >
                  <Crosshair className="h-4 w-4" />
                  Выбрать
                </Button>
              </div>
              {matrixCells.length > 0 && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Grid3x3 className="h-3 w-3" />
                  {matrixCells.length} ячеек выбрано
                </div>
              )}
            </div>
          )}

          {/* Comment */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fc-comment" className="text-xs">
              Комментарий (необязательно)
            </Label>
            <Input
              id="fc-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="h-9"
              placeholder="Что значит эта величина"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>
            <X className="h-4 w-4" />
            Отмена
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!canCreate}
            className="bg-[#991b1b] hover:bg-[#7f1d1d] text-white"
          >
            <Plus className="h-4 w-4" />
            Создать
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
