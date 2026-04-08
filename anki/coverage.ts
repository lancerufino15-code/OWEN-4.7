import { normalizePlainText } from "../../pdf/normalize";
import type { AnkiStructuredCard } from "../../anki_house_style";

function buildAnkiDedupKey(note: AnkiStructuredCard): string {
  const normalizedText = normalizePlainText(String(note.text || "")).toLowerCase();
  const normalizedSource = normalizePlainText(String(note.source || "")).toLowerCase();
  return `${normalizedSource}||${normalizedText}`;
}

export function mergeAnkiNotesForCoverage(
  existing: AnkiStructuredCard[],
  additions: AnkiStructuredCard[],
  maxCount: number,
): AnkiStructuredCard[] {
  const merged = [...existing];
  const seen = new Set(existing.map(buildAnkiDedupKey));
  for (const note of additions) {
    if (merged.length >= maxCount) break;
    const key = buildAnkiDedupKey(note);
    if (seen.has(key)) continue;
    merged.push(note);
    seen.add(key);
  }
  return merged;
}
