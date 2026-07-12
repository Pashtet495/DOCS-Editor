// ============================================================================
// AutoFill DOCX substitution — client-side utility.
//
// Replaces {{AF###}} markers in a DOCX blob with the selected values from the
// AutoFillStore. The DOCX is a zip archive; we modify word/document.xml (and
// any header/footer XMLs) in-place, then re-zip.
//
// Markers are stored in single <w:t> elements (verified by inspection), so a
// simple string split/join replacement is sufficient. The replacement values
// are XML-escaped to prevent injection.
// ============================================================================

import JSZip from "jszip";
import {
  buildAutoFillValueMap,
  escapeXmlText,
  makeAutoFillMarker,
  type AutoFillStore,
} from "./autofill-types";

/**
 * Replace {{AF###}} markers in a DOCX blob with selected values.
 *
 * @param blob      The edit-mode DOCX (contains {{AF###}} markers).
 * @param store     The AutoFillStore with field definitions and selected values.
 * @returns A new DOCX blob with markers replaced by their selected values.
 *          Fields with no selected value keep their {{AF###}} marker.
 *          If the store has no selected values, the original blob is returned
 *          unchanged.
 */
export async function substituteAutoFillInDocx(
  blob: Blob,
  store: AutoFillStore,
): Promise<Blob> {
  const valueMap = buildAutoFillValueMap(store);
  if (valueMap.size === 0) return blob;

  const buf = new Uint8Array(await blob.arrayBuffer());
  const zip = await JSZip.loadAsync(buf);

  // Collect all XML parts that may contain text: document.xml + headers/footers.
  const xmlTargets: string[] = [];
  for (const path of Object.keys(zip.files)) {
    if (path.endsWith(".xml") && (path.startsWith("word/") || path === "word/document.xml")) {
      xmlTargets.push(path);
    }
  }

  let totalReplacements = 0;
  for (const path of xmlTargets) {
    const file = zip.file(path);
    if (!file) continue;
    let xml = await file.async("string");
    let fileReplacements = 0;
    for (const [fieldId, value] of valueMap) {
      const marker = makeAutoFillMarker(fieldId);
      if (xml.includes(marker)) {
        const escaped = escapeXmlText(value);
        const count = xml.split(marker).length - 1;
        xml = xml.split(marker).join(escaped);
        fileReplacements += count;
      }
    }
    if (fileReplacements > 0) {
      zip.file(path, xml);
      totalReplacements += fileReplacements;
    }
  }

  if (totalReplacements === 0) return blob;

  console.log(
    `[autofill-subst] substituted ${totalReplacements} markers in DOCX ` +
      `(${valueMap.size} fields with values)`,
  );

  return zip.generateAsync({
    type: "blob",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
