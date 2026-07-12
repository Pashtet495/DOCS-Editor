// ============================================================================
// Formula Renderer — renders LaTeX formulas directly to a PNG canvas image.
//
// Strategy: a self-contained canvas-based LaTeX renderer that handles the most
// common constructs (text, superscripts, subscripts, fractions, square roots,
// Greek letters, math symbols). No external fonts or CSS required — everything
// is drawn with the canvas 2D API using system serif fonts.
//
// This avoids the SVG foreignObject approach (which produces blank images
// because KaTeX's web fonts don't load inside an SVG-as-image context).
//
// KaTeX is still used for on-screen previews (calculator + dialog) where
// the browser DOM is available. This renderer is for document insertion only.
// ============================================================================

import type { FormulaStore, FormulaEntry } from "./types";

// ── Symbol mappings ────────────────────────────────────────────────────────

const GREEK_LOWER: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "π", rho: "ρ",
  varrho: "ρ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
};

const GREEK_UPPER: Record<string, string> = {
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const MATH_SYMBOLS: Record<string, string> = {
  sum: "∑", int: "∫", prod: "∏", coprod: "∐", bigcup: "⋃", bigcap: "⋂",
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈",
  equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝",
  infty: "∞", partial: "∂", nabla: "∇", angle: "∠", perp: "⊥", parallel: "∥",
  forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
  cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "∅",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉",
  to: "→", rightarrow: "→", gets: "←", leftarrow: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  uparrow: "↑", downarrow: "↓", updownarrow: "↕",
  mapsto: "↦", hookrightarrow: "↪", hookleftarrow: "↩",
  degree: "°", circ: "∘", bullet: "•", dagger: "†", ddagger: "‡",
  ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  prime: "′", backprime: "‵",
  Re: "ℜ", Im: "ℑ", aleph: "ℵ", hbar: "ℏ", ell: "ℓ", wp: "℘",
  flat: "♭", natural: "♮", sharp: "♯",
};

const FUNCTIONS = new Set([
  "sin", "cos", "tan", "sec", "csc", "cot",
  "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh",
  "log", "ln", "lg", "exp",
  "lim", "limsup", "liminf",
  "max", "min", "sup", "inf",
  "det", "dim", "gcd", "arg", "deg", "hom", "ker", "Pr",
]);

/** Combined symbol lookup. */
function lookupSymbol(name: string): string | null {
  if (GREEK_LOWER[name]) return GREEK_LOWER[name];
  if (GREEK_UPPER[name]) return GREEK_UPPER[name];
  if (MATH_SYMBOLS[name]) return MATH_SYMBOLS[name];
  if (name === "pi") return "π";
  return null;
}

// ── Token types ────────────────────────────────────────────────────────────

type Token =
  | { kind: "char"; text: string; italic: boolean }
  | { kind: "text"; text: string }
  | { kind: "sup"; children: Token[] }
  | { kind: "sub"; children: Token[] }
  | { kind: "frac"; num: Token[]; den: Token[] }
  | { kind: "sqrt"; children: Token[] }
  | { kind: "root"; index: Token[]; radicand: Token[] }
  | { kind: "group"; children: Token[] }
  | { kind: "space"; width: number }
  | { kind: "binop"; text: string }
  | { kind: "left"; delim: string }
  | { kind: "right"; delim: string }
  | { kind: "overline"; children: Token[] }
  | { kind: "underline"; children: Token[] }
  | { kind: "matrix"; env: string; rows: Token[][][] };

// ── Parser ──────────────────────────────────────────────────────────────────

class LatexParser {
  private s: string;
  private i = 0;

  constructor(s: string) {
    this.s = s;
  }

  parse(): Token[] {
    return this.parseUntil(null);
  }

  private parseUntil(end: string | null): Token[] {
    const tokens: Token[] = [];
    while (this.i < this.s.length) {
      if (end && this.s[this.i] === end) break;
      const token = this.parseToken();
      if (token) tokens.push(token);
    }
    return tokens;
  }

  private parseGroup(): Token[] {
    if (this.i < this.s.length && this.s[this.i] === "{") {
      this.i++;
      const children = this.parseUntil("}");
      if (this.i < this.s.length && this.s[this.i] === "}") this.i++;
      return children;
    }
    const token = this.parseToken();
    return token ? [token] : [];
  }

  private skipSpaces(): void {
    while (this.i < this.s.length && (this.s[this.i] === " " || this.s[this.i] === "\t" || this.s[this.i] === "\n")) {
      this.i++;
    }
  }

  private parseToken(): Token | null {
    if (this.i >= this.s.length) return null;
    const c = this.s[this.i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      this.i++;
      return null;
    }

    if (c === "{") {
      this.i++;
      const children = this.parseUntil("}");
      if (this.i < this.s.length && this.s[this.i] === "}") this.i++;
      return { kind: "group", children };
    }

    if (c === "^") {
      this.i++;
      const children = this.parseGroup();
      return { kind: "sup", children };
    }

    if (c === "_") {
      this.i++;
      const children = this.parseGroup();
      return { kind: "sub", children };
    }

    if (c === "\\") {
      this.i++;
      return this.parseCommand();
    }

    // Regular character — single letters are italic, digits/operators are upright
    this.i++;
    const isLetter = /[a-zA-Z]/.test(c);
    return { kind: "char", text: c, italic: isLetter };
  }

  private parseCommand(): Token | null {
    // Read command name (letters)
    let name = "";
    while (this.i < this.s.length && /[a-zA-Z]/.test(this.s[this.i])) {
      name += this.s[this.i++];
    }

    // If no letters followed \, it's a literal escaped character (e.g. \{ \} \\ \,)
    if (name === "") {
      if (this.i < this.s.length) {
        const c = this.s[this.i++];
        if (c === ",") return { kind: "space", width: 3 };
        if (c === ";") return { kind: "space", width: 6 };
        if (c === "!") return { kind: "space", width: 0 };
        if (c === ":") return { kind: "space", width: 4 };
        if (c === " ") return { kind: "space", width: 4 };
        // Literal character
        return { kind: "char", text: c, italic: false };
      }
      return null;
    }

    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const num = this.parseGroup();
      const den = this.parseGroup();
      return { kind: "frac", num, den };
    }

    if (name === "sqrt") {
      const children = this.parseGroup();
      return { kind: "sqrt", children };
    }

    if (name === "left") {
      if (this.i < this.s.length) {
        let delim = this.s[this.i++];
        if (delim === "\\") {
          // \left\| or \left\langle etc.
          let sym = "";
          while (this.i < this.s.length && /[a-zA-Z]/.test(this.s[this.i])) {
            sym += this.s[this.i++];
          }
          const mapped = lookupSymbol(sym);
          delim = mapped || delim;
        }
        return { kind: "left", delim };
      }
      return null;
    }

    if (name === "right") {
      if (this.i < this.s.length) {
        let delim = this.s[this.i++];
        if (delim === "\\") {
          let sym = "";
          while (this.i < this.s.length && /[a-zA-Z]/.test(this.s[this.i])) {
            sym += this.s[this.i++];
          }
          const mapped = lookupSymbol(sym);
          delim = mapped || delim;
        }
        return { kind: "right", delim };
      }
      return null;
    }

    if (name === "overline" || name === "bar") {
      const children = this.parseGroup();
      return { kind: "overline", children };
    }

    if (name === "underline") {
      const children = this.parseGroup();
      return { kind: "underline", children };
    }

    if (name === "text" || name === "mathrm" || name === "operatorname" || name === "textbf") {
      const children = this.parseGroup();
      // Flatten to text
      const text = flattenToText(children);
      return { kind: "text", text };
    }

    if (name === "mathit" || name === "mathbf" || name === "mathsf" || name === "mathtt") {
      return this.parseGroup()[0] || null;
    }

    if (name === "quad") return { kind: "space", width: 16 };
    if (name === "qquad") return { kind: "space", width: 32 };
    if (name === "thinspace" || name === ",") return { kind: "space", width: 3 };
    if (name === "medspace" || name === ":") return { kind: "space", width: 4 };
    if (name === "thickspace" || name === ";") return { kind: "space", width: 6 };

    if (name === "displaystyle" || name === "textstyle" || name === "scriptstyle" || name === "scriptscriptstyle") {
      // Skip style commands, parse the following group
      return this.parseToken();
    }

    if (name === "limits" || name === "nolimits") {
      return null; // Skip
    }

    if (name === "begin") {
      // Read the environment name: \begin{env}
      this.skipSpaces();
      let env = "";
      if (this.i < this.s.length && this.s[this.i] === "{") {
        this.i++;
        while (this.i < this.s.length && this.s[this.i] !== "}") {
          env += this.s[this.i++];
        }
        if (this.i < this.s.length && this.s[this.i] === "}") this.i++;
      }
      // Parse until \end{env}
      const rows: Token[][][] = [];
      let currentRow: Token[][] = [];
      let currentCell: Token[] = [];

      while (this.i < this.s.length) {
        // Check for \end{env}
        if (this.s[this.i] === "\\" && this.s.slice(this.i, this.i + 4) === "\\end") {
          this.i += 4;
          this.skipSpaces();
          if (this.i < this.s.length && this.s[this.i] === "{") {
            this.i++;
            let endEnv = "";
            while (this.i < this.s.length && this.s[this.i] !== "}") {
              endEnv += this.s[this.i++];
            }
            if (this.i < this.s.length && this.s[this.i] === "}") this.i++;
          }
          // Push last cell + row
          if (currentCell.length > 0 || currentRow.length > 0) {
            currentRow.push(currentCell);
            rows.push(currentRow);
          }
          break;
        }
        // Check for \\ (row separator)
        if (this.s[this.i] === "\\" && this.s[this.i + 1] === "\\") {
          this.i += 2;
          currentRow.push(currentCell);
          rows.push(currentRow);
          currentRow = [];
          currentCell = [];
          continue;
        }
        // Check for & (column separator)
        if (this.s[this.i] === "&") {
          this.i++;
          currentRow.push(currentCell);
          currentCell = [];
          continue;
        }
        // Parse next token into current cell
        const savedI = this.i;
        const token = this.parseToken();
        if (token) {
          currentCell.push(token);
        }
        if (this.i === savedI) {
          // Avoid infinite loop
          this.i++;
        }
      }
      return { kind: "matrix", env, rows };
    }

    // Function names (sin, cos, etc.)
    if (FUNCTIONS.has(name)) {
      return { kind: "text", text: name };
    }

    // Symbol lookup
    const sym = lookupSymbol(name);
    if (sym) {
      return { kind: "char", text: sym, italic: false };
    }

    // Big operators
    if (name === "bigoplus") return { kind: "char", text: "⨁", italic: false };
    if (name === "bigotimes") return { kind: "char", text: "⨂", italic: false };
    if (name === "bigodot") return { kind: "char", text: "⨀", italic: false };

    // Unknown command — render name as text
    return { kind: "text", text: name };
  }
}

function flattenToText(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    switch (t.kind) {
      case "char":
      case "text":
      case "binop":
        out += t.text;
        break;
      case "group":
        out += flattenToText(t.children);
        break;
      case "sup":
        out += "^" + flattenToText(t.children);
        break;
      case "sub":
        out += "_" + flattenToText(t.children);
        break;
      case "space":
        out += " ";
        break;
    }
  }
  return out;
}

// ── Layout + Drawing ──────────────────────────────────────────────────────

interface Metrics {
  width: number;
  ascent: number;
  descent: number;
}

const EMPTY_METRICS: Metrics = { width: 0, ascent: 0, descent: 0 };

/**
 * Measure and/or draw a sequence of tokens.
 * @param ctx Canvas 2D context
 * @param tokens Token list
 * @param x Starting X position
 * @param baselineY Baseline Y position
 * @param fontSize Current font size
 * @param color Fill color
 * @param draw If true, draw; if false, only measure
 * @returns Metrics (width, ascent, descent)
 */
function renderTokens(
  ctx: CanvasRenderingContext2D,
  tokens: Token[],
  x: number,
  baselineY: number,
  fontSize: number,
  color: string,
  draw: boolean,
): Metrics {
  let cursorX = x;
  let maxAscent = fontSize * 0.75;
  let maxDescent = fontSize * 0.25;

  for (const token of tokens) {
    switch (token.kind) {
      case "char": {
        const font = token.italic
          ? `italic ${fontSize}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`
          : `${fontSize}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`;
        ctx.font = font;
        const m = ctx.measureText(token.text);
        if (draw) {
          ctx.fillStyle = color;
          ctx.fillText(token.text, cursorX, baselineY);
        }
        cursorX += m.width;
        break;
      }

      case "text": {
        ctx.font = `${fontSize}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`;
        const m = ctx.measureText(token.text);
        if (draw) {
          ctx.fillStyle = color;
          ctx.fillText(token.text, cursorX, baselineY);
        }
        cursorX += m.width;
        break;
      }

      case "binop": {
        ctx.font = `${fontSize}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`;
        // Add small spacing around binary operators
        const m = ctx.measureText(token.text);
        if (draw) {
          ctx.fillStyle = color;
          ctx.fillText(token.text, cursorX + 3, baselineY);
        }
        cursorX += m.width + 6;
        break;
      }

      case "sup": {
        const supSize = fontSize * 0.7;
        const supBaseline = baselineY - fontSize * 0.45;
        const r = renderTokens(ctx, token.children, cursorX, supBaseline, supSize, color, draw);
        cursorX += r.width;
        maxAscent = Math.max(maxAscent, fontSize * 0.75 + fontSize * 0.45);
        break;
      }

      case "sub": {
        const subSize = fontSize * 0.7;
        const subBaseline = baselineY + fontSize * 0.3;
        const r = renderTokens(ctx, token.children, cursorX, subBaseline, subSize, color, draw);
        cursorX += r.width;
        maxDescent = Math.max(maxDescent, fontSize * 0.25 + fontSize * 0.3);
        break;
      }

      case "frac": {
        const numSize = fontSize * 0.9;
        const denSize = fontSize * 0.9;
        const gap = fontSize * 0.12;

        // Measure numerator and denominator
        const numR = renderTokens(ctx, token.num, 0, 0, numSize, color, false);
        const denR = renderTokens(ctx, token.den, 0, 0, denSize, color, false);
        const fracWidth = Math.max(numR.width, denR.width) + 8;

        if (draw) {
          // Numerator centered above the line
          const numX = cursorX + (fracWidth - numR.width) / 2;
          renderTokens(ctx, token.num, numX, baselineY - gap - numSize * 0.15, numSize, color, true);
          // Denominator centered below the line
          const denX = cursorX + (fracWidth - denR.width) / 2;
          renderTokens(ctx, token.den, denX, baselineY + gap + denSize * 0.85, denSize, color, true);
          // Fraction line
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, fontSize / 18);
          ctx.beginPath();
          ctx.moveTo(cursorX + 2, baselineY);
          ctx.lineTo(cursorX + fracWidth - 2, baselineY);
          ctx.stroke();
        }

        cursorX += fracWidth;
        maxAscent = Math.max(maxAscent, gap + numSize * 0.85);
        maxDescent = Math.max(maxDescent, gap + denSize * 0.25);
        break;
      }

      case "sqrt": {
        // Measure inner content
        const innerR = renderTokens(ctx, token.children, 0, 0, fontSize, color, false);
        const innerWidth = innerR.width + 4;
        const innerAscent = innerR.ascent;

        // √ symbol
        const sqrtFontSize = fontSize * 1.15;
        ctx.font = `${sqrtFontSize}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`;
        const sqrtM = ctx.measureText("√");
        const symWidth = sqrtM.width;

        const totalWidth = symWidth + innerWidth;

        if (draw) {
          // Draw √ symbol
          ctx.font = `${sqrtFontSize}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`;
          ctx.fillStyle = color;
          ctx.fillText("√", cursorX, baselineY);
          // Draw inner content
          renderTokens(ctx, token.children, cursorX + symWidth, baselineY, fontSize, color, true);
          // Draw overline above the radicand
          const overlineY = baselineY - innerAscent - 3;
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, fontSize / 16);
          ctx.beginPath();
          ctx.moveTo(cursorX + symWidth - 2, overlineY);
          ctx.lineTo(cursorX + symWidth + innerWidth, overlineY);
          ctx.stroke();
        }

        cursorX += totalWidth;
        maxAscent = Math.max(maxAscent, innerAscent + 5);
        break;
      }

      case "overline": {
        const innerR = renderTokens(ctx, token.children, 0, 0, fontSize, color, false);
        if (draw) {
          renderTokens(ctx, token.children, cursorX, baselineY, fontSize, color, true);
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, fontSize / 16);
          ctx.beginPath();
          ctx.moveTo(cursorX, baselineY - fontSize * 0.85);
          ctx.lineTo(cursorX + innerR.width, baselineY - fontSize * 0.85);
          ctx.stroke();
        }
        cursorX += innerR.width;
        maxAscent = Math.max(maxAscent, fontSize * 0.95);
        break;
      }

      case "underline": {
        const innerR = renderTokens(ctx, token.children, 0, 0, fontSize, color, false);
        if (draw) {
          renderTokens(ctx, token.children, cursorX, baselineY, fontSize, color, true);
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, fontSize / 16);
          ctx.beginPath();
          ctx.moveTo(cursorX, baselineY + fontSize * 0.25);
          ctx.lineTo(cursorX + innerR.width, baselineY + fontSize * 0.25);
          ctx.stroke();
        }
        cursorX += innerR.width;
        maxDescent = Math.max(maxDescent, fontSize * 0.35);
        break;
      }

      case "matrix": {
        // Measure all cells
        const cellPadding = fontSize * 0.3;
        const colGap = fontSize * 0.6;
        const rowGap = fontSize * 0.4;

        const numRows = token.rows.length;
        const numCols = numRows > 0 ? Math.max(...token.rows.map((r) => r.length)) : 0;

        // Measure each cell
        const cellMetrics: Metrics[][] = [];
        const colWidths: number[] = new Array(numCols).fill(0);
        const rowHeights: { ascent: number; descent: number }[] = new Array(numRows)
          .fill(null)
          .map(() => ({ ascent: 0, descent: 0 }));

        for (let r = 0; r < numRows; r++) {
          cellMetrics[r] = [];
          for (let c = 0; c < numCols; c++) {
            const cell = token.rows[r][c] || [];
            const m = renderTokens(ctx, cell, 0, 0, fontSize * 0.85, color, false);
            cellMetrics[r][c] = m;
            colWidths[c] = Math.max(colWidths[c], m.width);
            rowHeights[r].ascent = Math.max(rowHeights[r].ascent, m.ascent);
            rowHeights[r].descent = Math.max(rowHeights[r].descent, m.descent);
          }
        }

        const matrixWidth = colWidths.reduce((a, b) => a + b, 0) + colGap * (numCols - 1) + cellPadding * 2;
        const delimWidth = fontSize * 0.4;
        const totalMatrixWidth = matrixWidth + delimWidth * 2;

        // Compute total height
        let totalAscent = 0;
        let totalDescent = 0;
        const rowBaselines: number[] = [];
        let runningY = 0;
        for (let r = 0; r < numRows; r++) {
          const rowH = rowHeights[r].ascent + rowHeights[r].descent;
          rowBaselines[r] = runningY + rowHeights[r].ascent;
          runningY += rowH + rowGap;
        }
        const matrixHeight = runningY - rowGap;
        const centerOffset = (matrixHeight - fontSize) / 2;

        if (draw) {
          // Draw delimiters
          const leftDelim = token.env === "bmatrix" ? "[" : token.env === "pmatrix" ? "(" : token.env === "vmatrix" ? "|" : token.env === "Bmatrix" ? "{" : "";
          const rightDelim = token.env === "bmatrix" ? "]" : token.env === "pmatrix" ? ")" : token.env === "vmatrix" ? "|" : token.env === "Bmatrix" ? "}" : "";

          if (leftDelim) {
            ctx.font = `${fontSize * 1.3}px "Cambria Math", serif`;
            ctx.fillStyle = color;
            ctx.textBaseline = "middle";
            ctx.fillText(leftDelim, cursorX, baselineY - centerOffset + matrixHeight / 2 - fontSize * 0.1);
            ctx.textBaseline = "alphabetic";
          }
          if (rightDelim) {
            ctx.font = `${fontSize * 1.3}px "Cambria Math", serif`;
            ctx.fillStyle = color;
            ctx.textBaseline = "middle";
            ctx.fillText(rightDelim, cursorX + matrixWidth + delimWidth + cellPadding, baselineY - centerOffset + matrixHeight / 2 - fontSize * 0.1);
            ctx.textBaseline = "alphabetic";
          }

          // Draw cells
          let colX = cursorX + delimWidth + cellPadding;
          for (let c = 0; c < numCols; c++) {
            for (let r = 0; r < numRows; r++) {
              const cell = token.rows[r][c] || [];
              const m = cellMetrics[r][c];
              if (!m) continue;
              const cellX = colX + (colWidths[c] - m.width) / 2;
              const cellBaseline = baselineY - centerOffset + rowBaselines[r];
              renderTokens(ctx, cell, cellX, cellBaseline, fontSize * 0.85, color, true);
            }
            colX += colWidths[c] + colGap;
          }
        }

        cursorX += totalMatrixWidth;
        maxAscent = Math.max(maxAscent, matrixHeight / 2 + fontSize * 0.5);
        maxDescent = Math.max(maxDescent, matrixHeight / 2 + fontSize * 0.5);
        break;
      }

      case "group": {
        const r = renderTokens(ctx, token.children, cursorX, baselineY, fontSize, color, draw);
        cursorX += r.width;
        maxAscent = Math.max(maxAscent, r.ascent);
        maxDescent = Math.max(maxDescent, r.descent);
        break;
      }

      case "space": {
        cursorX += token.width;
        break;
      }

      case "left":
      case "right": {
        const delim = token.delim;
        if (delim === "." || delim === "") break;
        // Render delimiter with slightly larger font
        const delimSize = fontSize * 1.2;
        ctx.font = `${delimSize}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`;
        const m = ctx.measureText(delim);
        if (draw) {
          ctx.fillStyle = color;
          ctx.fillText(delim, cursorX, baselineY);
        }
        cursorX += m.width;
        maxAscent = Math.max(maxAscent, delimSize * 0.8);
        break;
      }
    }
  }

  return { width: cursorX - x, ascent: maxAscent, descent: maxDescent };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface RenderFormulaOptions {
  latex: string;
  designation?: string;
  value?: number;
  /** 3 independent display flags — any combination of designation/formula/value */
  showDesignation?: boolean;
  showFormula?: boolean;
  showValue?: boolean;
  showNumber?: boolean;
  equationNumber?: number;
  showDescription?: boolean;
  descriptionText?: string;
  formulaStore?: FormulaStore | null;
  formula?: FormulaEntry | null;
  fontSize?: number;
  /** Legacy display field — converted to showDesignation/showFormula/showValue */
  display?: "formula" | "value" | "both";
}

export interface RenderedFormula {
  dataUrl: string;
  width: number;
  height: number;
}

/** Page width for formula rendering (matches A4 content area at 96dpi). */
const PAGE_WIDTH = 720;

import { getMath, loadMath } from "./math-loader";

/** Convert a plain math expression to LaTeX using math.js.
 *  e.g. "(-b-sqrt(D))/(2*a)" → "\\frac{-b - \\sqrt{D}}{2 a}"
 *       "D^(1/2)" → "D^{\\frac{1}{2}}"
 *  If math.js is not yet loaded, returns the raw expression and triggers async load.
 */
function exprToLatex(expr: string): string {
  const math = getMath();
  if (!math) {
    loadMath().catch(() => {});
    return expr;
  }
  try {
    const node = math.parse(expr);
    return node.toTex({ parenthesis: "auto" });
  } catch {
    return expr;
  }
}

/** Build the LaTeX string for the formula display.
 *  Combines designation, formula, and value in a single line:
 *  e.g. "D = b^2 - 4ac = 49"
 *  The formula part is converted to proper LaTeX via math.js (sqrt→√, frac, etc.)
 */
function buildLatexString(opts: {
  latex: string;
  designation?: string;
  value?: number;
  showDesignation: boolean;
  showFormula: boolean;
  showValue: boolean;
}): string {
  const parts: string[] = [];
  if (opts.showDesignation && opts.designation) {
    parts.push(opts.designation);
  }
  if (opts.showFormula && opts.latex) {
    // Convert the plain math expression to proper LaTeX using math.js
    parts.push(exprToLatex(opts.latex));
  }
  if (opts.showValue) {
    const valStr = opts.value !== undefined && !isNaN(opts.value)
      ? formatNumber(opts.value)
      : "?";
    parts.push(valStr);
  }
  // Join with " = " — e.g. "D = b^2 - 4ac = 49"
  return parts.join(" = ");
}

/** Render a formula to a PNG data URL using canvas.
 *  Renders designation, formula, and value as a SINGLE LINE in LaTeX style:
 *  e.g. "D = b^2 - 4ac = 49" — all in one row, same font/style.
 *  Equation number at the right, description below.
 */
export async function renderFormula(opts: RenderFormulaOptions): Promise<RenderedFormula> {
  const {
    latex,
    designation = "",
    value,
    showNumber = false,
    equationNumber,
    showDescription = false,
    descriptionText,
    formulaStore,
    formula,
    fontSize = 22,
  } = opts;

  // Convert legacy display to show flags
  let showDesignation = opts.showDesignation;
  let showFormula = opts.showFormula;
  let showValue = opts.showValue;
  if (showDesignation === undefined && showFormula === undefined && showValue === undefined) {
    // Legacy mode: use display field
    const display = opts.display || "both";
    showDesignation = false;
    showFormula = display === "formula" || display === "both";
    showValue = display === "value" || display === "both";
  } else {
    showDesignation = showDesignation ?? true;
    showFormula = showFormula ?? true;
    showValue = showValue ?? true;
  }

  if (typeof document === "undefined") {
    return { dataUrl: "", width: 0, height: 0 };
  }

  // Build the combined LaTeX string
  const combinedLatex = buildLatexString({
    latex,
    designation,
    value,
    showDesignation,
    showFormula,
    showValue,
  });

  if (!combinedLatex) {
    return { dataUrl: "", width: 0, height: 0 };
  }

  // ── First pass: measure ──
  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d")!;
  const padding = 24;
  const lineHeight = fontSize * 1.6;

  // Parse and measure the combined formula
  const tokens = new LatexParser(combinedLatex).parse();
  const formulaMetrics = renderTokens(mctx, tokens, 0, 0, fontSize, "#1f2937", false);

  // Measure equation number
  let numberText = "";
  if (showNumber && equationNumber) {
    numberText = `(${equationNumber})`;
  }
  mctx.font = `${Math.round(fontSize * 0.7)}px sans-serif`;
  const numberMetrics = mctx.measureText(numberText);

  // Build description text
  let descText = "";
  if (showDescription) {
    const vars = formula ? extractVariables(formula.formula) : [];
    const varDescs: string[] = [];
    for (const v of vars) {
      const vFormula = formulaStore?.formulas.find((f) => f.name === v);
      varDescs.push(`${v} — ${vFormula?.comment || "—"}`);
    }
    descText = vars.length ? "где: " + varDescs.join(", ") : "";
    if (descriptionText) descText += (descText ? "\n" : "") + descriptionText;
  }

  // ── Compute canvas size — full page width ──
  const canvasWidth = PAGE_WIDTH;
  const numberAreaWidth = numberText ? numberMetrics.width + padding : 0;

  let totalHeight = padding * 2 + lineHeight;
  if (descText) {
    const descLines = wrapText(descText, canvasWidth - padding * 2, mctx, Math.round(fontSize * 0.65));
    totalHeight += descLines.length * fontSize * 1.3 + 10;
  }

  // ── Second pass: draw ──
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = Math.max(totalHeight, 60);
  const ctx = canvas.getContext("2d")!;

  // Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw the combined formula (designation = formula = value) in one line, centered
  const formulaAreaStart = padding;
  const formulaAreaEnd = canvas.width - numberAreaWidth - padding;
  const formulaAreaCenter = (formulaAreaStart + formulaAreaEnd) / 2;
  const formulaX = formulaAreaCenter - formulaMetrics.width / 2;
  const y = padding + fontSize;
  renderTokens(ctx, tokens, formulaX, y, fontSize, "#1f2937", true);

  // Equation number — rightmost position, vertically centered
  if (numberText) {
    ctx.fillStyle = "#666";
    ctx.font = `${Math.round(fontSize * 0.7)}px sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(numberText, canvas.width - padding, padding + fontSize * 0.7);
    ctx.textAlign = "left";
  }

  // Description — BELOW the formula, full width
  let descY = y + lineHeight * 0.5;
  if (descText) {
    const descLines = wrapText(descText, canvas.width - padding * 2, ctx, Math.round(fontSize * 0.65));
    ctx.fillStyle = "#666";
    ctx.font = `${Math.round(fontSize * 0.65)}px sans-serif`;
    ctx.textBaseline = "alphabetic";
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, descY);
    ctx.lineTo(canvas.width - padding, descY);
    ctx.stroke();
    descY += fontSize * 0.8;
    for (const line of descLines) {
      ctx.fillText(line, padding, descY);
      descY += fontSize * 1.1;
    }
  }

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

/** Wrap text to fit within a given width. */
function wrapText(text: string, maxWidth: number, ctx: CanvasRenderingContext2D, fontSize: number): string[] {
  ctx.font = `${fontSize}px sans-serif`;
  const paragraphs = text.split("\n");
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(" ");
    let currentLine = "";
    for (const word of words) {
      const testLine = currentLine ? currentLine + " " + word : word;
      const m = ctx.measureText(testLine);
      if (m.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    if (!para) lines.push("");
  }
  return lines;
}

/** Extract variable names from a formula (excludes functions & constants). */
export function extractVariables(formula: string): string[] {
  const reserved = new Set([
    "sin", "cos", "tan", "sqrt", "log", "ln", "pi", "e", "exp", "abs",
    "asin", "acos", "atan", "floor", "ceil", "round", "pow", "min", "max",
    "frac", "sum", "int", "lim", "cdot", "times", "alpha", "beta", "gamma",
    "delta", "theta", "lambda", "mu", "sigma", "omega", "phi", "psi", "xi",
    "epsilon", "rho", "tau", "kappa", "zeta", "nu", "upsilon", "chi", "eta",
    "iota", "infty", "partial", "nabla", "leq", "geq", "neq",
  ]);
  const matches = formula.match(/[a-zA-Z][a-zA-Z0-9_]*/g) || [];
  const out: string[] = [];
  for (const m of matches) {
    if (reserved.has(m)) continue;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

function formatNumber(n: number): string {
  if (!isFinite(n)) return String(n);
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 14 });
}
