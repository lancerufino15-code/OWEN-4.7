/**
 * Lightweight retrieval helpers for PDF/text chunking and scoring.
 *
 * Used by: `src/index.ts` to chunk extracted text and rank chunks for RAG.
 *
 * Key exports:
 * - `RetrievalChunk` type
 * - `chunkText`, `chunkTextWithPositions`, `rankChunks`
 *
 * Assumptions:
 * - Tokenization is simple and heuristic; scores are approximate.
 */
const STOPWORDS = new Set([
  "the", "and", "a", "an", "of", "to", "in", "on", "for", "with", "at", "by", "from", "as", "is", "it", "this", "that",
  "these", "those", "be", "are", "was", "were", "or", "if", "then", "else", "but", "so", "than", "too", "very", "can",
  "could", "should", "would", "may", "might", "will", "just", "do", "does", "did", "not", "no", "yes",
]);

/**
 * Chunk of text with optional scoring and positional metadata.
 */
export type RetrievalChunk = { index: number; text: string; score?: number; start?: number; end?: number; page?: number; slide?: number };

/**
 * Split text into overlapping chunks by character count.
 *
 * @param text - Input text to chunk.
 * @param opts - Chunking options (size and overlap in characters).
 * @returns List of chunks with sequential indices.
 */
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): RetrievalChunk[] {
  const size = opts.size ?? 2000;
  const overlap = opts.overlap ?? 200;
  if (!text) return [];
  const normalized = text.trim();
  if (!normalized) return [];

  const chunks: RetrievalChunk[] = [];
  let index = 0;
  for (let start = 0; start < normalized.length; start += size - overlap) {
    const end = Math.min(normalized.length, start + size);
    const slice = normalized.slice(start, end).trim();
    if (slice) {
      chunks.push({ index, text: slice });
      index += 1;
    }
    if (end >= normalized.length) break;
  }
  return chunks;
}

/**
 * Split text into chunks while tracking original character positions.
 *
 * @param text - Input text to chunk.
 * @param opts - Chunking options (size and overlap in characters).
 * @returns List of chunks with start/end offsets.
 */
export function chunkTextWithPositions(text: string, opts: { size?: number; overlap?: number } = {}): RetrievalChunk[] {
  const size = opts.size ?? 2000;
  const overlap = opts.overlap ?? 200;
  if (!text) return [];
  const normalized = text || "";
  if (!normalized.trim()) return [];

  const chunks: RetrievalChunk[] = [];
  let index = 0;
  for (let start = 0; start < normalized.length; start += size - overlap) {
    const end = Math.min(normalized.length, start + size);
    const rawSlice = normalized.slice(start, end);
    const leading = rawSlice.match(/^\s*/)?.[0].length ?? 0;
    const trailing = rawSlice.match(/\s*$/)?.[0].length ?? 0;
    const trimmed = rawSlice.slice(leading, rawSlice.length - trailing);
    if (trimmed) {
      const chunkStart = start + leading;
      const chunkEnd = end - trailing;
      chunks.push({ index, text: trimmed, start: chunkStart, end: chunkEnd });
      index += 1;
    }
    if (end >= normalized.length) break;
  }
  return chunks;
}

/**
 * Rank chunks by token overlap with a query string.
 *
 * @param question - Query text to match against.
 * @param chunks - Candidate chunks.
 * @param topK - Maximum number of chunks to return.
 * @returns Top-ranked chunks with scores.
 */
export function rankChunks(question: string, chunks: RetrievalChunk[], topK = 6): RetrievalChunk[] {
  if (!Array.isArray(chunks) || !chunks.length) return [];
  const queryTokens = tokenize(question);
  if (!queryTokens.size) return chunks.slice(0, topK).map((chunk, idx) => ({ ...chunk, score: topK - idx }));

  const scored = chunks.map(chunk => {
    const tokens = tokenize(chunk.text);
    let score = 0;
    tokens.forEach(token => {
      if (queryTokens.has(token)) score += 2;
    });
    // Favor shorter, denser chunks slightly
    const lengthPenalty = Math.max(1, chunk.text.length / 5000);
    const finalScore = score / lengthPenalty;
    return { ...chunk, score: finalScore };
  });

  return scored
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topK);
}

function tokenize(text: string): Set<string> {
  const tokens = (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(token => token.trim())
    .filter(token => token && !STOPWORDS.has(token));
  return new Set(tokens);
}
