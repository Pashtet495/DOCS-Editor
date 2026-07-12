"use client";

/**
 * CellLinkDialog — modal for creating a link between table cell(s) and
 * a single auto-fill field ("Link to AutoFill" action in the TableEditorDialog header).
 *
 * Supports both single cell (A1) and range (A1:A5) selection.
 * For ranges, all cells are linked to ONE AF field — every cell value becomes
 * a variant of that field.
 */

import React from "react";
import { Crosshair, Check, X, Link2, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toCellRef, parseCellRef, colToLetter, letterToCol } from "@/lib/table/cell-utils";

export interface CellLinkDialogProps {
  open: boolean;
  /** When true, the dialog shrinks to a small "pick cell" bar. */
  picking: boolean;
  /** Currently picked cell (controlled by parent). */
  pickedCell: { row: number; col: number } | null;
  /** Initial coordinate text (e.g. "A1" or "A1:B5") — pre-filled when dialog opens. */
  initialCoord?: string;
  /** Called when the user clicks "Pick cell" or "Done". */
  onPickingChange: (p: boolean) => void;
  /** Called when the user clicks Create — receives label, description, and
   *   an array of {row, col} cells (single cell for non-range, multiple for range).
   *   All cells will be linked to ONE AF field (range → variants). */
  onCreate: (cells: Array<{ row: number; col: number }>, label: string, description: string) => void;
  /** Called when the dialog is closed (Cancel / X / Escape / outside click). */
  onClose: () => void;
}

/** Parse a coordinate string that may be a single ref (A1) or a range (A1:A5).
 *  Returns an array of {row, col} for all cells in the range. */
function parseCoordRange(text: string): Array<{ row: number; col: number }> {
  const trimmed = text.trim().toUpperCase();
  if (!trimmed) return [];

  // Check for range: A1:B5
  const rangeMatch = trimmed.match(/^(\$?)([A-Z]+)(\$?)(\d+):(\$?)([A-Z]+)(\$?)(\d+)$/);
  if (rangeMatch) {
    const startCol = letterToCol(rangeMatch[2]);
    const startRow = parseInt(rangeMatch[4], 10) - 1;
    const endCol = letterToCol(rangeMatch[6]);
    const endRow = parseInt(rangeMatch[8], 10) - 1;
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);
    const cells: Array<{ row: number; col: number }> = [];
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        cells.push({ row: r, col: c });
      }
    }
    return cells;
  }

  // Single cell
  const single = parseCellRef(trimmed);
  if (single) return [{ row: single.row, col: single.col }];
  return [];
}

export function CellLinkDialog(props: CellLinkDialogProps) {
  const { open, picking, pickedCell, initialCoord, onPickingChange, onCreate, onClose } = props;

  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  /** Manual coordinate typed by the user (overrides pickedCell when valid). */
  const [coordText, setCoordText] = React.useState("");

  // Reset form whenever the dialog opens — use initialCoord if provided
  // (which may be a range like "A1:B5"), otherwise fall back to pickedCell.
  React.useEffect(() => {
    if (open) {
      setLabel("");
      setDescription("");
      if (initialCoord) {
        setCoordText(initialCoord);
      } else if (pickedCell) {
        setCoordText(toCellRef(pickedCell.row, pickedCell.col));
      } else {
        setCoordText("");
      }
    }
  }, [open, pickedCell, initialCoord]);

  // Keep coordText in sync with pickedCell (e.g. when user clicks a cell
  // during pick mode, pickedCell changes and we update the input).
  React.useEffect(() => {
    if (pickedCell) {
      setCoordText(toCellRef(pickedCell.row, pickedCell.col));
    }
  }, [pickedCell]);

  // Parse the coordinate text into an array of cells
  const cells = parseCoordRange(coordText);
  const isRange = cells.length > 1;
  const isValid = cells.length > 0;

  // Escape exits pick mode (without closing the whole dialog).
  React.useEffect(() => {
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

  const handleCreate = () => {
    if (!isValid) return;
    const effectiveLabel = label.trim() || (isRange
      ? `Диапазон ${coordText}`
      : `Ячейка ${toCellRef(cells[0].row, cells[0].col)}`);
    onCreate(cells, effectiveLabel, description);
  };

  // -----------------------------------------------------------------------
  // Pick mode — small bar with the coordinate input and a "Done" button.
  // -----------------------------------------------------------------------

  if (picking && open) {
    return (
      <div
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[10005] flex w-[420px] max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border bg-background p-3 shadow-xl"
        role="dialog"
        aria-label="Выбор ячейки"
      >
        <Crosshair className="h-4 w-4 text-primary flex-shrink-0" />
        <span className="text-sm font-medium flex-shrink-0">Ячейка:</span>
        <Input
          value={coordText}
          onChange={(e) => setCoordText(e.target.value)}
          className="h-8 flex-1 font-mono"
          placeholder="A1 или A1:A5"
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
        <p className="sr-only">Кликните ячейку в таблице, чтобы выбрать её. Для диапазона введите A1:A5.</p>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Full mode — the standard create form.
  // -----------------------------------------------------------------------

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
            <Link2 className="h-4 w-4 text-primary" />
            Связать ячейку с автозаполнением
          </DialogTitle>
          <DialogDescription>
            Создаёт поле автозаполнения, синхронизированное со значением выбранной ячейки.
            {" "}Для диапазона введите, напр., A1:A5 — все ячейки будут связаны с одним полем
            (значения станут вариантами).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="cl-label">Имя поля {isRange && `(для диапазона из ${cells.length} ячеек)`}</Label>
            <Input
              id="cl-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={isRange ? "Напр. «Позиция»" : "Напр. «Сумма НДС»"}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="cl-desc">Описание</Label>
            <Input
              id="cl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Что значит это значение (для AI)"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="cl-coord">Координата ячейки или диапазон</Label>
            <div className="flex items-center gap-2">
              <Input
                id="cl-coord"
                value={coordText}
                onChange={(e) => setCoordText(e.target.value)}
                className="font-mono"
                placeholder="A1 или A1:A5"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => onPickingChange(true)}
                title="Выбрать ячейку в таблице"
              >
                <Crosshair className="h-4 w-4" />
                Выбрать
              </Button>
            </div>
            {coordText && !isValid && (
              <span className="text-xs text-destructive">
                Неверный формат (используйте A1 или A1:A5)
              </span>
            )}
          </div>
        </div>

        <div className="flex justify-between items-center pt-2">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            {isRange ? (
              <>
                <List className="h-3 w-3" />
                Диапазон: {cells.length} ячеек ({coordText})
              </>
            ) : isValid ? (
              <>
                Ячейка: <span className="font-mono">{toCellRef(cells[0].row, cells[0].col)}</span>
              </>
            ) : (
              "Ячейка не выбрана"
            )}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              <X className="h-4 w-4" />
              Отмена
            </Button>
            <Button onClick={handleCreate} disabled={!isValid}>
              <Link2 className="h-4 w-4" />
              {isRange ? `Создать связь (${cells.length} ячеек)` : "Создать связь"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
