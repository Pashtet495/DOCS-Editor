// ============================================================================
// Markdown & Clipboard Conversion
//
// Convert between Cell[][] and:
//  - Markdown tables (for AI consumption / AI response parsing)
//  - TSV (tab-separated values, for clipboard / Excel compat)
//
// Markdown table convention used here:
//   - Header row contains cell refs (A1, B1, C1, ...) so the AI knows the
//     exact target location when a zone is exported with an offset.
//   - Separator row is the standard GFM "--- | --- | ---".
//   - Formula cells are serialized as "formula=computedValue", e.g. "=A1+B1=42".
//     When parsed back, the part before the second "=" becomes `raw`, the part
//     after becomes `computed`.
//
// No React, no DOM. Pure string <-> cell transforms.
// ============================================================================

import type { Cell, CellStyle, NamedZone, TableDoc } from "./types";
import { toCellRef } from "./cell-utils";

// CellStyle is part of the public surface of this module (callers may pass
// styled cells in) — re-exported here for convenience.
export type { CellStyle };

/**
 * Convert a 2D array of cells to a Markdown table string.
 *  - Formula cells: "formula=computedValue" (e.g. "=A1+B1=42")
 *  - Non-formula cells: just the raw value
 *  - Empty/null cells render as empty string
 *
 * @param cells     2D array of cells (rows x cols). Rows may have varying
 *                  lengths; the widest row determines column count.
 * @param rowOffset 0-indexed row of the top-left cell in the parent table.
 *                  Used only to generate header cell refs (default 0).
 * @param colOffset 0-indexed col of the top-left cell in the parent table.
 *                  Used only to generate header cell refs (default 0).
 */
export function cellsToMarkdown(
  cells: (Cell | null)[][],
  rowOffset = 0,
  colOffset = 0,
): string {
  if (cells.length === 0) return "";
  const colCount = cells.reduce((max, row) => Math.max(max, row.length), 0);
  if (colCount === 0) return "";

  const lines: string[] = [];

  // Header row: cell refs of the top row (A1, B1, C1, ...)
  const headerCells: string[] = [];
  for (let c = 0; c < colCount; c++) {
    headerCells.push(toCellRef(rowOffset, colOffset + c));
  }
  lines.push("| " + headerCells.join(" | ") + " |");
  lines.push("| " + headerCells.map(() => "---").join(" | ") + " |");

  // Data rows
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r];
    const parts: string[] = [];
    for (let c = 0; c < colCount; c++) {
      parts.push(cellToMarkdownText(row[c]));
    }
    lines.push("| " + parts.join(" | ") + " |");
  }

  return lines.join("\n");
}

/** Render a single cell as markdown cell text. */
function cellToMarkdownText(cell: Cell | null): string {
  if (!cell) return "";
  const raw = cell.raw;
  if (raw == null || raw === "") return "";
  if (raw.startsWith("=")) {
    // Formula cell: "formula=computedValue"
    const computed = cell.computed == null ? "" : String(cell.computed);
    return `${raw}=${computed}`;
  }
  // Non-formula: just the value
  return raw;
}

/**
 * Parse a Markdown table string into a 2D array of Cell objects.
 *  - Handles GFM table syntax (| col1 | col2 | with --- separator row)
 *  - The header row + separator row are SKIPPED — only data rows are returned
 *  - Cells starting with "=" are treated as formulas
 *  - "formula=value" format is split: raw=formula, computed=value
 *  - Numeric strings become numbers in `computed`; everything else stays a string
 *  - Returns an empty array if no table lines are found
 */
export function markdownToCells(md: string): (Cell | null)[][] {
  if (!md || md.trim() === "") return [];

  const lines = md.split(/\r?\n/);
  // Keep only lines that look like table rows (start and end with |)
  const tableLines = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|"));

  if (tableLines.length === 0) return [];

  // Detect GFM separator row (| --- | :--: | ---: |)
  const hasSeparator =
    tableLines.length >= 2 && /^\|[\s\-:|]+\|$/.test(tableLines[1]);

  const dataLines = hasSeparator ? tableLines.slice(2) : tableLines;

  return dataLines.map((line) =>
    parseMdRow(line).map((text) => parseCellFromMarkdown(text)),
  );
}

/** Split a single MD table row (| a | b | c |) into trimmed cell strings.
 *  Handles escaped pipes (\|) inside cells. */
function parseMdRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // Split on | but not on \|
  // Use a placeholder for escaped pipes, split, then restore
  const ESCAPED_PIPE = "\x00PIPE\x00";
  s = s.replace(/\\\|/g, ESCAPED_PIPE);
  const parts = s.split("|").map((p) => {
    p = p.trim();
    return p.replace(new RegExp(ESCAPED_PIPE, "g"), "|");
  });
  return parts;
}

/** Parse markdown inline formatting into raw text + CellStyle.
 *  Supports: **bold**, *italic*, `code`, [text](url), and combinations.
 *  Returns { raw, style } where style has bold/italic flags set. */
function parseMarkdownInline(text: string): { raw: string; style: CellStyle } {
  let raw = text;
  const style: CellStyle = {};

  // [text](url) → just keep the text part
  raw = raw.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // `code` → remove backticks (could set monospace font in the future)
  const codeMatch = raw.match(/`([^`]+)`/);
  if (codeMatch) {
    style.fontFamily = "Consolas";
    raw = raw.replace(/`([^`]+)`/g, "$1");
  }

  // **bold** → bold=true
  if (/\*\*[^*]+\*\*/.test(raw)) {
    style.bold = true;
    raw = raw.replace(/\*\*([^*]+)\*\*/g, "$1");
  }

  // *italic* → italic=true (after bold is processed)
  if (/\*[^*]+\*/.test(raw)) {
    style.italic = true;
    raw = raw.replace(/\*([^*]+)\*/g, "$1");
  }

  // ~~strikethrough~~
  if (/~~[^~]+~~/.test(raw)) {
    style.strikethrough = true;
    raw = raw.replace(/~~([^~]+)~~/g, "$1");
  }

  return { raw, style };
}

/** Parse a single cell-text string into a Cell (or null if empty).
 *  Handles markdown formatting (**bold**, *italic*, `code`, [link](url)). */
function parseCellFromMarkdown(text: string): Cell | null {
  if (text === "") return null;

  // Formula cell — starts with "="
  if (text.startsWith("=")) {
    // Look for "formula=value" pattern: the SECOND "=" splits raw and computed.
    const secondEq = text.indexOf("=", 1);
    if (secondEq !== -1) {
      const raw = text.slice(0, secondEq);
      const valueStr = text.slice(secondEq + 1);
      return { raw, computed: valueStrToComputed(valueStr) };
    }
    // Pure formula, no computed value provided
    return { raw: text, computed: null };
  }

  // Non-formula cell — parse markdown inline formatting
  const { raw, style } = parseMarkdownInline(text);
  if (raw === "") return null;

  const cell: Cell = { raw, computed: valueStrToComputed(raw) };
  // Attach style only if any formatting was detected
  if (Object.keys(style).length > 0) {
    cell.style = style;
  }
  return cell;
}

/** Convert a string to its computed value: number if parseable, else string.
 *  Empty string -> null. */
function valueStrToComputed(value: string): string | number | null {
  if (value === "") return null;
  const num = Number(value);
  if (!isNaN(num) && isFinite(num) && value.trim() !== "") {
    return num;
  }
  return value;
}

/**
 * Convert a 2D array of cells to TSV (tab-separated values) for clipboard.
 * Uses COMPUTED values (not formulas) for Excel compat — pasting into Excel
 * gives the user the evaluated numbers/strings, not the formula text.
 */
export function cellsToTSV(cells: (Cell | null)[][]): string {
  if (cells.length === 0) return "";
  return cells
    .map((row) =>
      row
        .map((cell) => {
          if (!cell) return "";
          if (cell.computed == null) return "";
          return String(cell.computed);
        })
        .join("\t"),
    )
    .join("\n");
}

/** Parse TSV from clipboard into a 2D array of raw strings.
 *  - Split on newlines (handles \n, \r\n, \r)
 *  - Each line split on tabs
 *  - Empty TSV -> empty array */
export function tsvToCells(tsv: string): string[][] {
  if (!tsv || tsv === "") return [];
  return tsv.split(/\r?\n/).map((line) => {
    if (line === "") return [];
    return line.split("\t");
  });
}

/**
 * Export a named zone to Markdown for AI consumption.
 * Output format:
 *   # Zone: <name>
 *
 *   <description>
 *
 *   | A1 | B1 | C1 |
 *   | --- | --- | --- |
 *   | ...data... |
 *
 *  Cell refs in the header reflect the zone's position in the parent table.
 */
export function zoneToMarkdown(table: TableDoc, zone: NamedZone): string {
  const header: string[] = [
    `# Zone: ${zone.name}`,
    "",
    zone.description,
    "",
  ];

  // Extract the zone's cells from the parent table
  const zoneCells: (Cell | null)[][] = [];
  for (let r = 0; r < zone.rowSpan; r++) {
    const row: (Cell | null)[] = [];
    for (let c = 0; c < zone.colSpan; c++) {
      const tr = zone.row + r;
      const tc = zone.col + c;
      if (
        table.cells &&
        tr >= 0 &&
        tr < table.cells.length &&
        table.cells[tr] &&
        tc >= 0 &&
        tc < table.cells[tr].length
      ) {
        row.push(table.cells[tr][tc]);
      } else {
        row.push(null);
      }
    }
    zoneCells.push(row);
  }

  const md = cellsToMarkdown(zoneCells, zone.row, zone.col);
  return header.join("\n") + md;
}

/**
 * Parse an AI response (Markdown table) into a 2D array of Cell objects ready
 * to be written into a table region. The caller is responsible for deciding
 * the target offset (typically a previously-exported zone's top-left).
 *
 * @param md Markdown table string from the AI
 * @returns `{ cells }` — a 2D array of Cell | null
 */
export function markdownToCellUpdates(md: string): {
  cells: (Cell | null)[][];
} {
  return { cells: markdownToCells(md) };
}
