// ============================================================================
// Auto-Fill Types — fields, variants, synchronization, and store.
//
// Supports:
//  - List-based sync (1:N): one field's value maps to a LIST of values in
//    another field. e.g. AF001:Труба → AF002:[20х10, 20х20, 40х40]
//  - Field instances (card duplicates): {{AF001}}, {{AF001_1}}, {{AF001_2}} —
//    each instance has its own selectedValue but shares the same variants.
//  - Cell-level sync in the table editor.
// ============================================================================

/** A single instance of a field — represents one marker insertion point.
 *  The primary instance has suffix "". Duplicates have suffixes "_1", "_2", etc.
 *  Each instance has its own selectedValue (for view-mode substitution). */
export interface AutoFillInstance {
  /** Suffix appended to the field id to form the marker: "", "_1", "_2", ... */
  suffix: string;
  /** Currently selected value for this instance (null = no selection). */
  selectedValue: string | null;
}

/** A single field for auto-fill in the document. */
export interface AutoFillField {
  /** Stable id, e.g. "AF001". */
  id: string;
  /** Human-readable label shown in the card. */
  label: string;
  /** Description for the AI (what this field is for). */
  description: string;
  /** The text in the document that was replaced by this field's marker.
   *  Empty if the field was created from scratch (not from existing text). */
  originalText: string;
  /** All possible values for this field. */
  variants: string[];
  /** Currently selected value of the PRIMARY instance (suffix "").
   *  Kept for backward compat — same as instances[0].selectedValue. */
  selectedValue: string | null;
  /** Sync group id — fields with the same syncGroupId are linked. */
  syncGroupId: string | null;
  /** Whether this field is marked as "single" (only individual insert) or "sync" (linked). */
  insertMode: "single" | "sync";
  /** All insertion instances of this field. instances[0] is always the primary
   *  (suffix ""). Additional instances are duplicates created via the "+" button.
   *  If undefined, treated as a single primary instance. */
  instances?: AutoFillInstance[];
}

/** Synchronization group — defines linked fields and their value mappings.
 *
 *  Mappings support LIST sync (1:N): a source field's value maps to a LIST of
 *  values in each target field.
 *
 *  Format: { "sourceFieldId:sourceValue": { "targetFieldId": ["val1", "val2"] } }
 *
 *  Backward compat: old format had string values instead of arrays. Use
 *  normalizeMappings() to convert on load. */
export interface AutoFillSyncGroup {
  id: string;
  /** Field IDs in this group. */
  fieldIds: string[];
  /** Mappings: { "fieldId1:value1": { "fieldId2": ["v1","v2"], "fieldId3": ["v3"] } }
   *  Each key is "sourceField:sourceValue". Each target field maps to a list
   *  of allowed values (the synced options shown when the source is selected). */
  mappings: Record<string, Record<string, string[]>>;
}

/** The complete auto-fill store. */
export interface AutoFillStore {
  fields: AutoFillField[];
  syncGroups: AutoFillSyncGroup[];
  /** Filter for variant display: "all" | "single" | "sync" */
  variantFilter: "all" | "single" | "sync";
  /** Currently active instance suffix per field (for the UI selector).
   *  { "AF001": "_1" } means the UI is editing AF001's _1 instance. */
  activeInstance?: Record<string, string>;
}

/** XML table format for .docs persistence. */
export interface AutoFillXmlTable {
  columns: Array<{
    fieldId: string;
    label: string;
    description: string;
  }>;
  rows: string[][];
  syncGroups: Array<{
    id: string;
    fieldIds: string[];
  }>;
}

// ============================================================================
// Agent commands for auto-fill
// ============================================================================

export type AutoFillCommand =
  | {
      cmd: "CREATE_FIELD";
      label: string;
      description: string;
      replaceText?: string;
      variants?: string[];
    }
  | {
      cmd: "FILL_FIELD";
      fieldId: string;
      value: string;
    }
  | {
      cmd: "SYNC_FIELDS";
      fieldIds: string[];
      /** Mappings: { "fieldId1:value": { "fieldId2": ["v1","v2"] } } */
      mappings: Record<string, Record<string, string[]>>;
    }
  | {
      cmd: "ADD_VARIANTS";
      fieldId: string;
      variants: string[];
    };

/** Create an empty AutoFillStore. */
export function createEmptyAutoFillStore(): AutoFillStore {
  return {
    fields: [],
    syncGroups: [],
    variantFilter: "all",
    activeInstance: {},
  };
}

/** Generate the next available AF-number id. */
export function nextAutoFillFieldId(fields: AutoFillField[]): string {
  const maxNum = fields
    .filter((f) => /^AF\d+$/.test(f.id))
    .reduce((max, f) => Math.max(max, parseInt(f.id.slice(2), 10)), 0);
  return `AF${String(maxNum + 1).padStart(3, "0")}`;
}

// ============================================================================
// Markers — support both {{AF001}} and {{AF001_1}} (instance suffixes)
// ============================================================================

/** Marker format: {{AF001}} or {{AF001_1}} (with instance suffix). */
export const AF_MARKER_RE = /\{\{(AF\d{3}(?:_\d+)?)\}\}/g;

/** Full marker id including suffix: "AF001" or "AF001_1". */
export function makeAutoFillMarker(fullId: string): string {
  return `{{${fullId}}}`;
}

/** Create a marker for a field id + instance suffix.
 *  makeMarkerForInstance("AF001", "") → "{{AF001}}"
 *  makeMarkerForInstance("AF001", "_1") → "{{AF001_1}}" */
export function makeMarkerForInstance(fieldId: string, suffix: string): string {
  return `{{${fieldId}${suffix}}}`;
}

/** Extract full marker ids (with suffix) from text. */
export function findAutoFillMarkers(text: string): string[] {
  const matches = text.match(AF_MARKER_RE);
  return matches ? matches.map((m) => m.slice(2, -2)) : [];
}

/** Parse a full marker id into { fieldId, suffix }.
 *  "AF001_1" → { fieldId: "AF001", suffix: "_1" }
 *  "AF001" → { fieldId: "AF001", suffix: "" } */
export function parseMarkerId(fullId: string): { fieldId: string; suffix: string } {
  const m = fullId.match(/^(AF\d{3})(_\d+)?$/);
  if (!m) return { fieldId: fullId, suffix: "" };
  return { fieldId: m[1], suffix: m[2] || "" };
}

// ============================================================================
// Instance helpers
// ============================================================================

/** Get all instances of a field. Always returns at least the primary instance. */
export function getFieldInstances(field: AutoFillField): AutoFillInstance[] {
  if (field.instances && field.instances.length > 0) {
    return field.instances;
  }
  return [{ suffix: "", selectedValue: field.selectedValue }];
}

/** Get the active instance suffix for a field (from store.activeInstance). */
export function getActiveSuffix(store: AutoFillStore, fieldId: string): string {
  return store.activeInstance?.[fieldId] || "";
}

/** Get the selected value for a specific instance of a field. */
export function getInstanceValue(field: AutoFillField, suffix: string): string | null {
  const instances = getFieldInstances(field);
  return instances.find((i) => i.suffix === suffix)?.selectedValue ?? null;
}

/** Generate the next available instance suffix for a field ("_1", "_2", ...). */
export function nextInstanceSuffix(field: AutoFillField): string {
  const instances = getFieldInstances(field);
  const maxNum = instances
    .filter((i) => /^_\d+$/.test(i.suffix))
    .reduce((max, i) => Math.max(max, parseInt(i.suffix.slice(1), 10)), 0);
  return `_${maxNum + 1}`;
}

// ============================================================================
// Sync mapping helpers — normalize old format, access list values
// ============================================================================

/** Normalize mappings from possibly-old format (string values) to new format
 *  (array values). Old: { "AF001:x": { "AF002": "y" } } →
 *  New: { "AF001:x": { "AF002": ["y"] } } */
export function normalizeMappings(
  mappings: Record<string, Record<string, unknown>>,
): Record<string, Record<string, string[]>> {
  const result: Record<string, Record<string, string[]>> = {};
  for (const [key, targets] of Object.entries(mappings)) {
    result[key] = {};
    for (const [targetField, value] of Object.entries(targets)) {
      if (Array.isArray(value)) {
        result[key][targetField] = value.map(String);
      } else if (value != null && value !== "") {
        result[key][targetField] = [String(value)];
      }
    }
  }
  return result;
}

/** Get the list of synced values for a target field given a source selection.
 *  Returns [] if no mapping exists. */
export function getSyncedValues(
  group: AutoFillSyncGroup,
  sourceFieldId: string,
  sourceValue: string,
  targetFieldId: string,
): string[] {
  const key = `${sourceFieldId}:${sourceValue}`;
  return group.mappings[key]?.[targetFieldId] || [];
}

// ============================================================================
// Marker substitution — replace {{AF001}} and {{AF001_1}} markers
// ============================================================================

/** Build a map of fullMarkerId → selectedValue from the store, considering
 *  ALL instances of every field. Keys include the suffix: "AF001", "AF001_1". */
export function buildAutoFillValueMap(store: AutoFillStore): Map<string, string> {
  const map = new Map<string, string>();
  for (const field of store.fields) {
    const instances = getFieldInstances(field);
    for (const inst of instances) {
      if (inst.selectedValue != null && inst.selectedValue !== "") {
        const fullId = `${field.id}${inst.suffix}`;
        map.set(fullId, inst.selectedValue);
      }
    }
  }
  return map;
}

/** Escape special XML characters for DOCX text content. */
export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Walk a ProseMirror JSON tree and replace {{AF###}} / {{AF###_N}} markers
 * in text nodes with the selected values from the store (all instances).
 *
 * Markers that have no selected value are left untouched.
 * PURE function — does not mutate the input.
 */
export function substituteAutoFillInJson(json: unknown, store: AutoFillStore): unknown {
  const valueMap = buildAutoFillValueMap(store);
  if (valueMap.size === 0) return json;
  return walkPmJson(json, valueMap);
}

function walkPmJson(node: unknown, valueMap: Map<string, string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => walkPmJson(item, valueMap));
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      let text = obj.text;
      let changed = false;
      for (const [fullId, value] of valueMap) {
        const marker = makeAutoFillMarker(fullId);
        if (text.includes(marker)) {
          text = text.split(marker).join(value);
          changed = true;
        }
      }
      if (changed) {
        return { ...obj, text };
      }
      return obj;
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      result[key] = walkPmJson(obj[key], valueMap);
    }
    return result;
  }
  return node;
}

// ============================================================================
// XML table conversion (for the table editor dialog)
// ============================================================================

/** Convert AutoFillStore to XML table format for the editor. */
export function autoFillStoreToXmlTable(store: AutoFillStore): AutoFillXmlTable {
  const columns = store.fields.map((f) => ({
    fieldId: f.id,
    label: f.label,
    description: f.description,
  }));

  const maxVariants = Math.max(0, ...store.fields.map((f) => f.variants.length));
  const rows: string[][] = [];
  for (let i = 0; i < maxVariants; i++) {
    const row: string[] = [];
    for (const field of store.fields) {
      row.push(field.variants[i] || "");
    }
    rows.push(row);
  }

  return {
    columns,
    rows,
    syncGroups: store.syncGroups.map((g) => ({
      id: g.id,
      fieldIds: g.fieldIds,
    })),
  };
}

/** Convert XML table back to AutoFillStore.
 *  NOTE: sync group mappings are NOT rebuilt from rows (the table editor uses
 *  cell-level sync checkboxes separately). Mappings are preserved via the
 *  editor's own draft state. */
export function xmlTableToAutoFillStore(table: AutoFillXmlTable): AutoFillStore {
  const fields: AutoFillField[] = table.columns.map((col, colIdx) => {
    const variants = table.rows
      .map((row) => row[colIdx] || "")
      .filter((v) => v.trim() !== "");

    const syncGroup = table.syncGroups.find((g) => g.fieldIds.includes(col.fieldId));

    return {
      id: col.fieldId,
      label: col.label,
      description: col.description,
      originalText: "",
      variants,
      selectedValue: null,
      syncGroupId: syncGroup?.id || null,
      insertMode: syncGroup ? "sync" : "single",
      instances: [{ suffix: "", selectedValue: null }],
    };
  });

  return {
    fields,
    syncGroups: table.syncGroups.map((g) => ({
      id: g.id,
      fieldIds: g.fieldIds,
      mappings: {},
    })),
    variantFilter: "all",
    activeInstance: {},
  };
}
