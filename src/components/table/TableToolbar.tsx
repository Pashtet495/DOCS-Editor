"use client";

/**
 * TableToolbar — the formatting toolbar above the grid.
 *
 * Features:
 *  - Font family + size dropdowns (show current cell's values).
 *  - B / I / U / S toggle buttons — show "pressed" state from active cell.
 *  - Custom color palettes for font color and fill color (Popover + presets).
 *  - Horizontal / vertical alignment (active state shown).
 *  - Text rotation dropdown (shows current rotation).
 *  - Merge / Unmerge.
 *  - Border buttons with visual icons (not text symbols).
 *  - Delete row/col. (Row/col insertion is handled by hover "+" buttons
 *    between the headers inside TableGrid.)
 *
 * All style buttons apply to the CURRENT SELECTION.
 */

import React, { useState } from "react";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  GitMerge,
  Unlink,
  Trash2,
  Check,
  FunctionSquare,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import type { CellStyle, Selection } from "@/lib/table/types";
import { cn } from "@/lib/utils";

const FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Georgia",
  "Calibri",
  "Cambria",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Courier New",
  "Consolas",
];

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28];

const ROTATIONS = [
  { value: "0", label: "0°" },
  { value: "45", label: "45°" },
  { value: "90", label: "90°" },
  { value: "-45", label: "-45°" },
  { value: "-90", label: "-90°" },
];

const BLACK_BORDER = { style: "thin" as const, color: "#000000" };

/** Preset color palette for the color pickers. */
const COLOR_PRESETS = [
  "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff",
  "#ffff00", "#ff00ff", "#00ffff", "#808080", "#c0c0c0",
  "#800000", "#808000", "#008000", "#008080", "#000080",
  "#800080", "#ff9999", "#99ff99", "#9999ff", "#ffff99",
  "#ff99ff", "#99ffff", "#cccccc", "#666666",
];

// ---------------------------------------------------------------------------
// ToolButton — a small ghost icon button with a tooltip.
// ---------------------------------------------------------------------------

function ToolButton({
  tooltip,
  onClick,
  children,
  active,
  disabled,
}: {
  tooltip: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "default" : "ghost"}
          size="icon"
          className={cn("h-8 w-8", active && "bg-primary text-primary-foreground")}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// ColorPaletteButton — custom color palette in a Popover
// ---------------------------------------------------------------------------

function ColorPaletteButton({
  tooltip,
  currentColor,
  onPick,
  children,
}: {
  tooltip: string;
  currentColor?: string;
  onPick: (color: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 relative"
          title={tooltip}
        >
          {children}
          {currentColor && (
            <span
              className="absolute bottom-0 left-0 right-0 h-1 rounded-b"
              style={{ backgroundColor: currentColor }}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">{tooltip}</div>
          <div className="grid grid-cols-8 gap-1">
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                className="h-6 w-6 rounded border border-gray-300 hover:scale-110 transition-transform"
                style={{ backgroundColor: color }}
                onClick={() => {
                  onPick(color);
                  setOpen(false);
                }}
                title={color}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 pt-2 border-t">
            <input
              type="color"
              value={currentColor || "#000000"}
              onChange={(e) => onPick(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded border"
            />
            <span className="text-xs text-muted-foreground">Произвольный цвет</span>
          </div>
          {currentColor && (
            <Button
              size="sm"
              variant="outline"
              className="w-full h-7 text-xs"
              onClick={() => {
                onPick("");
                setOpen(false);
              }}
            >
              Сбросить цвет
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// BorderButton — visual border icon using a mini grid
// ---------------------------------------------------------------------------

function BorderButton({
  tooltip,
  onClick,
  active,
  sides,
}: {
  tooltip: string;
  onClick: () => void;
  active?: boolean;
  /** Which sides of the mini grid to show as thick black lines. */
  sides: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean; all?: boolean; none?: boolean };
}) {
  const borderClass = "border-black";
  return (
    <ToolButton tooltip={tooltip} onClick={onClick} active={active}>
      <div
        className="h-4 w-4 border border-gray-300"
        style={{
          borderTopWidth: sides.all || sides.top ? 2 : 1,
          borderTopColor: sides.all || sides.top ? "#000" : "#d1d5db",
          borderBottomWidth: sides.all || sides.bottom ? 2 : 1,
          borderBottomColor: sides.all || sides.bottom ? "#000" : "#d1d5db",
          borderLeftWidth: sides.all || sides.left ? 2 : 1,
          borderLeftColor: sides.all || sides.left ? "#000" : "#d1d5db",
          borderRightWidth: sides.all || sides.right ? 2 : 1,
          borderRightColor: sides.all || sides.right ? "#000" : "#d1d5db",
          borderStyle: sides.none ? "dashed" : "solid",
        }}
      />
    </ToolButton>
  );
}

// ---------------------------------------------------------------------------
// Main toolbar
// ---------------------------------------------------------------------------

export interface TableToolbarProps {
  selection: Selection;
  /** Style of the primary selected cell — for showing toggle states. */
  activeStyle: CellStyle;
  onApplyStyle: (patch: Partial<CellStyle>) => void;
  onMerge: () => void;
  onUnmerge: () => void;
  onDeleteRow: (row: number) => void;
  onDeleteCol: (col: number) => void;
  /** Open the "link cell to calculator formula" dialog (f button). */
  onLinkFormula: () => void;
  /** Open the "create new formula/constant" dialog (f+ button). */
  onCreateFormula: () => void;
  /** Open the "link cell to auto-fill" dialog (AZ button). */
  onLinkAutoFill: () => void;
}

export function TableToolbar(props: TableToolbarProps) {
  const {
    selection,
    activeStyle,
    onApplyStyle,
    onMerge,
    onUnmerge,
    onDeleteRow,
    onDeleteCol,
    onLinkFormula,
    onCreateFormula,
    onLinkAutoFill,
  } = props;

  const minRow = Math.min(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-wrap items-center gap-1 border-b bg-background px-2 py-1.5">
        {/* Font family */}
        <Select
          value={activeStyle.fontFamily || "__default__"}
          onValueChange={(v) => onApplyStyle({ fontFamily: v === "__default__" ? undefined : v })}
        >
          <SelectTrigger size="sm" className="h-8 w-[140px]">
            <SelectValue placeholder="Шрифт" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">По умолчанию</SelectItem>
            {FONT_FAMILIES.map((f) => (
              <SelectItem key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Font size */}
        <Select
          value={activeStyle.fontSize ? String(activeStyle.fontSize) : "__default__"}
          onValueChange={(v) => onApplyStyle({ fontSize: v === "__default__" ? undefined : Number(v) })}
        >
          <SelectTrigger size="sm" className="h-8 w-[64px]">
            <SelectValue placeholder="11" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">—</SelectItem>
            {FONT_SIZES.map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* B / I / U / S — toggle buttons showing active state */}
        <ToolButton
          tooltip="Жирный (Ctrl+B)"
          onClick={() => onApplyStyle({ bold: !activeStyle.bold })}
          active={!!activeStyle.bold}
        >
          <Bold className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          tooltip="Курсив (Ctrl+I)"
          onClick={() => onApplyStyle({ italic: !activeStyle.italic })}
          active={!!activeStyle.italic}
        >
          <Italic className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          tooltip="Подчёркнутый (Ctrl+U)"
          onClick={() => onApplyStyle({ underline: !activeStyle.underline })}
          active={!!activeStyle.underline}
        >
          <Underline className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          tooltip="Зачёркнутый"
          onClick={() => onApplyStyle({ strikethrough: !activeStyle.strikethrough })}
          active={!!activeStyle.strikethrough}
        >
          <Strikethrough className="h-4 w-4" />
        </ToolButton>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Font color + fill color — custom palettes */}
        <ColorPaletteButton
          tooltip="Цвет текста"
          currentColor={activeStyle.fontColor}
          onPick={(c) => onApplyStyle({ fontColor: c || undefined })}
        >
          <span className="text-sm font-bold" style={{ color: activeStyle.fontColor || "#dc2626" }}>
            A
          </span>
        </ColorPaletteButton>

        <ColorPaletteButton
          tooltip="Цвет заливки"
          currentColor={activeStyle.fillColor}
          onPick={(c) => onApplyStyle({ fillColor: c || undefined })}
        >
          <span
            className="inline-block h-4 w-4 rounded-sm border"
            style={{ backgroundColor: activeStyle.fillColor || "#fde047" }}
          />
        </ColorPaletteButton>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Horizontal alignment */}
        <ToolButton
          tooltip="По левому краю"
          onClick={() => onApplyStyle({ hAlign: activeStyle.hAlign === "left" ? undefined : "left" })}
          active={activeStyle.hAlign === "left"}
        >
          <AlignLeft className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          tooltip="По центру"
          onClick={() => onApplyStyle({ hAlign: activeStyle.hAlign === "center" ? undefined : "center" })}
          active={activeStyle.hAlign === "center"}
        >
          <AlignCenter className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          tooltip="По правому краю"
          onClick={() => onApplyStyle({ hAlign: activeStyle.hAlign === "right" ? undefined : "right" })}
          active={activeStyle.hAlign === "right"}
        >
          <AlignRight className="h-4 w-4" />
        </ToolButton>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Vertical alignment */}
        <ToolButton
          tooltip="По верхнему краю"
          onClick={() => onApplyStyle({ vAlign: activeStyle.vAlign === "top" ? undefined : "top" })}
          active={activeStyle.vAlign === "top"}
        >
          <AlignVerticalJustifyStart className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          tooltip="По центру (верт.)"
          onClick={() => onApplyStyle({ vAlign: activeStyle.vAlign === "middle" ? undefined : "middle" })}
          active={activeStyle.vAlign === "middle"}
        >
          <AlignVerticalJustifyCenter className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          tooltip="По нижнему краю"
          onClick={() => onApplyStyle({ vAlign: activeStyle.vAlign === "bottom" ? undefined : "bottom" })}
          active={activeStyle.vAlign === "bottom"}
        >
          <AlignVerticalJustifyEnd className="h-4 w-4" />
        </ToolButton>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Text rotation */}
        <Select
          value={activeStyle.textRotation !== undefined ? String(activeStyle.textRotation) : "__default__"}
          onValueChange={(v) => onApplyStyle({ textRotation: v === "__default__" ? undefined : Number(v) })}
        >
          <SelectTrigger size="sm" className="h-8 w-[72px]">
            <SelectValue placeholder="0°" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">0°</SelectItem>
            {ROTATIONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Merge / Unmerge */}
        <ToolButton tooltip="Объединить ячейки" onClick={onMerge}>
          <GitMerge className="h-4 w-4" />
        </ToolButton>
        <ToolButton tooltip="Разъединить" onClick={onUnmerge}>
          <Unlink className="h-4 w-4" />
        </ToolButton>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Borders — visual icons */}
        <BorderButton
          tooltip="Граница снизу"
          onClick={() => onApplyStyle({ borderBottom: activeStyle.borderBottom ? undefined : BLACK_BORDER })}
          active={!!activeStyle.borderBottom}
          sides={{ bottom: true }}
        />
        <BorderButton
          tooltip="Граница сверху"
          onClick={() => onApplyStyle({ borderTop: activeStyle.borderTop ? undefined : BLACK_BORDER })}
          active={!!activeStyle.borderTop}
          sides={{ top: true }}
        />
        <BorderButton
          tooltip="Граница слева"
          onClick={() => onApplyStyle({ borderLeft: activeStyle.borderLeft ? undefined : BLACK_BORDER })}
          active={!!activeStyle.borderLeft}
          sides={{ left: true }}
        />
        <BorderButton
          tooltip="Граница справа"
          onClick={() => onApplyStyle({ borderRight: activeStyle.borderRight ? undefined : BLACK_BORDER })}
          active={!!activeStyle.borderRight}
          sides={{ right: true }}
        />
        <BorderButton
          tooltip="Все границы"
          onClick={() => {
            const hasAll = activeStyle.borderTop && activeStyle.borderBottom && activeStyle.borderLeft && activeStyle.borderRight;
            if (hasAll) {
              onApplyStyle({ borderTop: undefined, borderBottom: undefined, borderLeft: undefined, borderRight: undefined });
            } else {
              onApplyStyle({ borderTop: BLACK_BORDER, borderBottom: BLACK_BORDER, borderLeft: BLACK_BORDER, borderRight: BLACK_BORDER });
            }
          }}
          sides={{ all: true }}
        />
        <BorderButton
          tooltip="Без границ"
          onClick={() => onApplyStyle({ borderTop: undefined, borderBottom: undefined, borderLeft: undefined, borderRight: undefined })}
          sides={{ none: true }}
        />

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Link cell to AutoFill — icon is text-lines with a chain badge,
            similar to alignment buttons but indicating a link to the
            document's AutoFill fields. */}
        <ToolButton
          tooltip="Добавить связь ячейки с автозаполнением документа"
          onClick={onLinkAutoFill}
        >
          <LinkLinesIcon className="h-4 w-4" />
        </ToolButton>

        {/* Formula link buttons — integrate table cells with the calculator */}
        <ToolButton
          tooltip="Связать с формулой калькулятора"
          onClick={onLinkFormula}
        >
          <span className="flex items-center justify-center font-bold text-sm text-[#991b1b]">
            f
          </span>
        </ToolButton>
        <ToolButton
          tooltip="Создать новую формулу/константу"
          onClick={onCreateFormula}
        >
          <span className="flex items-center justify-center font-bold text-sm text-[#991b1b]">
            <Plus className="h-3 w-3" />
            f
          </span>
        </ToolButton>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Delete row/col. (Insertion is via hover "+" buttons in the grid.) */}
        <ToolButton
          tooltip="Удалить строку"
          onClick={() => {
            for (let r = maxRow; r >= minRow; r--) onDeleteRow(r);
          }}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </ToolButton>
        <ToolButton
          tooltip="Удалить столбец"
          onClick={() => {
            for (let c = maxCol; c >= minCol; c--) onDeleteCol(c);
          }}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </ToolButton>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// LinkLinesIcon — three horizontal text-lines (like the alignment buttons)
// with a small chain-link badge in the bottom-right. Indicates "link this
// cell to a document AutoFill field".
// ---------------------------------------------------------------------------

function LinkLinesIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Three text lines (like AlignLeft icon) */}
      <line x1="3" y1="6" x2="18" y2="6" />
      <line x1="3" y1="10" x2="14" y2="10" />
      <line x1="3" y1="14" x2="16" y2="14" />
      {/* Chain-link badge in the bottom-right corner */}
      <path
        d="M18.5 12.5l-2 2a2 2 0 0 0 0 3l0.5 0.5"
        fill="none"
      />
      <path
        d="M21 15l-2 2a2 2 0 0 1-3 0l-0.5-0.5"
        fill="none"
      />
      <path
        d="M18.5 12.5l1-1a2 2 0 0 1 3 0l0.5 0.5"
        fill="none"
      />
      <path
        d="M21 15l1-1a2 2 0 0 0 0-3l-0.5-0.5"
        fill="none"
      />
    </svg>
  );
}
