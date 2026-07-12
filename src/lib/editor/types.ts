// ============================================================================
// Document Map — the intermediate JSON layer between the WYSIWYG editor and AI.
// Every block carries an optional `embedding` vector so the document can be
// queried with RAG before being fed to an LLM agent.
// ============================================================================

export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'quote'
  | 'code'
  | 'divider'
  | 'image'
  | 'table'
  | 'canvas'
  | 'external-ref'
  | 'formula';

export interface BlockBase {
  /** Stable block id, e.g. "B007". */
  id: string;
  type: BlockType;
  /** Optional style reference, e.g. "S01". */
  styleId?: string;
  /** RAG embedding vector (computed from block text). */
  embedding?: number[];
  /** Model that produced the embedding. */
  embeddingModel?: string;
  /** Free-form metadata (page hints, revision notes, etc.). */
  meta?: Record<string, unknown>;
}

export interface HeadingBlock extends BlockBase {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  content: string;
}
export interface ParagraphBlock extends BlockBase {
  type: 'paragraph';
  content: string;
}
export interface ListBlock extends BlockBase {
  type: 'list';
  ordered: boolean;
  items: string[];
}
export interface QuoteBlock extends BlockBase {
  type: 'quote';
  content: string;
}
export interface CodeBlock extends BlockBase {
  type: 'code';
  lang: string;
  content: string;
}
export interface DividerBlock extends BlockBase {
  type: 'divider';
}
export interface ImageBlock extends BlockBase {
  type: 'image';
  src: string;
  alt?: string;
}
export interface TableBlock extends BlockBase {
  type: 'table';
  headers: string[];
  rows: string[][];
  /** When set, the table is backed by an external resource (e.g. XML sheet). */
  sourceRef?: string;
}
export interface CanvasBlock extends BlockBase {
  type: 'canvas';
  lang: 'js' | 'ts';
  code: string;
  title?: string;
}
export interface ExternalRefBlock extends BlockBase {
  type: 'external-ref';
  resourceId: string;
  /** Optional XPath / selector to pull a specific value. */
  query?: string;
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | QuoteBlock
  | CodeBlock
  | DividerBlock
  | ImageBlock
  | TableBlock
  | CanvasBlock
  | ExternalRefBlock
  | FormulaBlock;

export interface FormulaDisplayOptions {
  /** What to show: formula LaTeX, computed value, or both. */
  display: 'formula' | 'value' | 'both';
  /** Show equation number on the right, e.g. (1). */
  showNumber?: boolean;
  /** Show "где: var - comment" section below. */
  showDescription?: boolean;
  /** Which variables to include in description (by name). If omitted, all. */
  descriptionVars?: string[];
  /** Custom text below "Где:" section. */
  descriptionText?: string;
}

export interface FormulaBlock extends BlockBase {
  type: 'formula';
  /** Formula ID from FormulaStore, e.g. "F003". */
  formulaId: string;
  /** LaTeX expression. */
  latex: string;
  /** Computed value (updated on recalc). */
  value?: number;
  /** Display options. */
  displayOptions: FormulaDisplayOptions;
  /** Equation number (auto-assigned). */
  equationNumber?: number;
}

export interface StyleDef {
  id: string; // S01
  name: string;
  appliesTo: BlockType;
  font?: string;
  size?: number; // pt
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  lineHeight?: number;
}

export type ResourceType = 'xml' | 'json' | 'csv' | 'canvas';

export interface ExternalResource {
  id: string; // R001
  name: string;
  type: ResourceType;
  content: string;
  description?: string;
  dataUrl?: string;
  lang?: 'js' | 'ts';
}

// ============================================================================
// LaTeX Formula System — unified formula/constant entities.
// Formulas in the calculator ARE the same entities referenced in the document.
// Document contains {{F001}} markers; calculator stores the formula + value.
// ============================================================================

/** A formula entity — used both in calculator and as document reference. */
export interface FormulaEntry {
  id: string;             // F001
  name: string;           // variable name, e.g. "x1", "a", "D" — used as designation
  formula: string;        // expression, e.g. "(-b + sqrt(D)) / (2*a)"
  value?: number;         // computed value
  latex?: string;         // LaTeX representation for display (optional)
  comment?: string;
  /** True if this formula is referenced in the document via {{F001}}. */
  inDocument?: boolean;
  /** Block IDs where this formula is referenced. */
  blockIds?: string[];
  userCreated?: boolean;
  pinned?: boolean;
  /** Manual equation number (when set, overrides auto-numbering). */
  number?: number;
}

/** Legacy alias — CalcConstant is now the same as FormulaEntry. */
export type CalcConstant = FormulaEntry;

export interface CalcHistoryEntry {
  expr: string;
  result: string;
  raw: string | number;
}

export interface FormulaStore {
  /** All formula entities (constants + formulas + document references). */
  formulas: FormulaEntry[];
  history: CalcHistoryEntry[];
  settings: {
    resultFormat: 'normal' | 'scientific';
    angleUnit: 'deg' | 'rad';
  };
}

export interface PageSize {
  width: number; // px @ 96dpi (A4 ~ 794 x 1123)
  height: number;
}

export interface DocumentMap {
  meta: {
    id: string;
    title: string;
    version: string;
    createdAt: string;
    updatedAt: string;
    pageSize: PageSize;
    margin: number;
    author?: string;
  };
  styles: StyleDef[];
  blocks: Block[];
  externalResources: ExternalResource[];
  /** LaTeX formula store — saved in .docs archive. */
  formulaStore?: FormulaStore;
}

// ============================================================================
// AI Agent command protocol — the LLM emits a JSON array of these commands;
// the executor applies them to the DocumentMap.
// ============================================================================

export type NewBlockSpec = {
  id: string;
  type: BlockType;
} & Record<string, unknown>;

export type AgentCommand =
  | {
      cmd: 'EDIT_BLOCK';
      blockId: string;
      /** Anchor text that must exist before the edited region. */
      textBefore?: string;
      /** Anchor text that must exist after the edited region. */
      textAfter?: string;
      /** New full content for the block. */
      newContent?: string;
      /** Or a find/replace pair. */
      find?: string;
      replace?: string;
    }
  | {
      cmd: 'CREATE_BLOCK';
      /** Insert after this block; null means "at the very beginning". */
      afterBlockId: string | null;
      newBlock: NewBlockSpec;
    }
  | { cmd: 'DELETE_BLOCK'; blockId: string }
  | { cmd: 'MOVE_BLOCK'; blockId: string; afterBlockId: string | null }
  | { cmd: 'UPDATE_STYLE'; blockId: string; styleId: string }
  | {
      cmd: 'INSERT_CANVAS';
      afterBlockId: string | null;
      lang: 'js' | 'ts';
      code: string;
      title?: string;
    }
  | {
      cmd: 'LINK_RESOURCE';
      afterBlockId: string | null;
      resourceId: string;
      query?: string;
    }
  | {
      cmd: 'CREATE_RESOURCE';
      name: string;
      type: ResourceType;
      content: string;
      description?: string;
    }
  | { cmd: 'SET_TITLE'; title: string }
  | {
      cmd: 'CREATE_FORMULA';
      name: string;
      formula: string;
      comment?: string;
    }
  | {
      cmd: 'UPDATE_FORMULA';
      formulaId: string;
      formula?: string;
      comment?: string;
    }
  | {
      cmd: 'INSERT_FORMULA_BLOCK';
      /** Formula ID from calculator, or "new" to create from formula expression. */
      formulaId: string;
      /** LaTeX expression (if formulaId is "new" or to override). */
      latex?: string;
      /** Where to insert: "B007" = after block B007, null = start, "end" = end. */
      afterBlockId: string | null;
      /** Display options. */
      display?: 'formula' | 'value' | 'both';
      showNumber?: boolean;
      showDescription?: boolean;
      /** Custom "Где:" text. */
      descriptionText?: string;
    };

export interface CommandResult {
  ok: boolean;
  command: AgentCommand;
  message: string;
  affectedBlockId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** When the assistant proposes commands, they live here for preview. */
  commands?: AgentCommand[];
  ts: number;
}

export interface ModelOption {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface RagHit {
  blockId: string;
  score: number;
  snippet: string;
}

// ============================================================================
// LLM provider settings (OpenAI-compatible — LM Studio, Ollama, OpenAI, etc.)
// ============================================================================

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  /** Matryoshka dimension truncation (0 = off / full). */
  matryoshkaDim: number;
}

export const DEFAULT_LLM: LlmSettings = {
  baseUrl: "http://localhost:1234/v1",
  apiKey: "lm-studio",
  chatModel: "",
  embeddingModel: "",
  matryoshkaDim: 0,
};

