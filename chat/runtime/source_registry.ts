import type { SourceRef } from "../response_contract";
import { normalizeSourceKey } from "./provider";

type SourceCandidate = {
  url: string;
  title?: string;
  domain?: string;
  snippet?: string;
};

export function buildSourceRegistry(candidates: SourceCandidate[], limit = 12): SourceRef[] {
  const deduped = new Map<string, SourceRef>();
  for (const candidate of candidates || []) {
    const rawUrl = typeof candidate?.url === "string" ? candidate.url.trim() : "";
    if (!rawUrl) continue;
    const key = normalizeSourceKey(rawUrl);
    if (!key) continue;
    if (deduped.has(key)) continue;
    deduped.set(key, {
      id: `S${deduped.size + 1}`,
      url: rawUrl,
      title: candidate.title?.trim() || rawUrl,
      domain: candidate.domain?.trim() || undefined,
      snippet: candidate.snippet?.trim() || undefined,
    });
    if (deduped.size >= limit) break;
  }
  return Array.from(deduped.values());
}
