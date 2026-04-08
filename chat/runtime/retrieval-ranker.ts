import type { FileContextRecord, RetrievalPlan } from "./types";

const DEFAULT_CHUNK_SIZE = 1800;
const DEFAULT_OVERLAP = 200;
const chunkCache = new Map<string, string[]>();

function chunkCacheKey(context: FileContextRecord): string {
  return `${context.resolvedKey}:${context.text.length}:${context.text.slice(0, 64)}`;
}

function normalizeText(text: string): string {
  return (text || "").replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function chunkText(text: string, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP): string[] {
  const normalized = normalizeText(text);
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + chunkSize);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) || []).slice(0, 40);
}

function scoreChunk(queryTokens: string[], chunk: string, context: FileContextRecord, selectedDocBias: string[]): number {
  const lower = chunk.toLowerCase();
  let score = 0;
  queryTokens.forEach((token) => {
    if (lower.includes(token)) score += 4;
  });
  if (/^[A-Z][A-Za-z0-9 /().-]{0,80}:\s/.test(chunk) || /^#+\s/.test(chunk)) score += 2;
  if (chunk.includes("|") || /\btable\b/i.test(chunk)) score += 2;
  if (selectedDocBias.includes(context.originalKey) || selectedDocBias.includes(context.resolvedKey)) score += 3;
  score += Math.min(3, Math.floor(chunk.length / 600));
  return score;
}

export function rankContextChunks(
  question: string,
  contexts: FileContextRecord[],
  retrievalPlan: RetrievalPlan,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const queryTokens = tokenize(question);
  const entries: Array<{ key: string; chunk: string; score: number; context: FileContextRecord }> = [];

  contexts.forEach((context) => {
    const cacheKey = chunkCacheKey(context);
    const chunks = chunkCache.get(cacheKey) || chunkText(context.text);
    if (!chunkCache.has(cacheKey)) {
      chunkCache.set(cacheKey, chunks);
    }
    chunks.forEach((chunk) => {
      entries.push({
        key: context.resolvedKey,
        chunk,
        score: scoreChunk(queryTokens, chunk, context, retrievalPlan.selectedDocBias),
        context,
      });
    });
  });

  const chosenBySource = new Map<string, string[]>();
  const sorted = entries.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key) || a.chunk.localeCompare(b.chunk));
  let totalChars = 0;
  for (const entry of sorted) {
    const existing = chosenBySource.get(entry.key) || [];
    if (existing.length >= 2) continue;
    if (totalChars + entry.chunk.length > retrievalPlan.contextCharBudget) continue;
    existing.push(entry.chunk);
    chosenBySource.set(entry.key, existing);
    totalChars += entry.chunk.length;
    if (Array.from(chosenBySource.values()).flat().length >= retrievalPlan.maxChunks) break;
  }

  contexts.forEach((context) => {
    const chosen = chosenBySource.get(context.resolvedKey) || [];
    map.set(context.resolvedKey, chosen.length ? chosen : (chunkCache.get(chunkCacheKey(context)) || chunkText(context.text)).slice(0, 1));
  });

  return map;
}
