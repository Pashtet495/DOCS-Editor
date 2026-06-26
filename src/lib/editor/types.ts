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
  | 'external-ref';

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
  | ExternalRefBlock;

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

export type ResourceType = 'xml' | 'json' | 'csv';

export interface ExternalResource {
  id: string; // R001
  name: string;
  type: ResourceType;
  content: string;
  description?: string;
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
  | { cmd: 'SET_TITLE'; title: string };

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

