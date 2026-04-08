/**
 * Metadata and prompt normalization helpers for analytics tagging.
 *
 * Used by: `analytics.ts` to extract canonical tokens, aliases, and display
 * phrases from user questions.
 *
 * Key exports:
 * - Token extraction and alias builders.
 * - Metadata weight helpers for filtering tags.
 *
 * Assumptions:
 * - English-centric stopword and preposition lists.
 */
import { MULTIWORD_PREPOSITION_REGEX, isArticleOrPreposition } from "../../lib/text/articles-prepositions";

/**
 * Map of normalized token to weight/count.
 */
export type MetaWeights = Record<string, number>;

const INLINE_STOPWORDS = new Set(["this", "that", "these", "those"]);
const META_STOPWORDS = new Set(["tell", "me", "different", "difference", "and", "best", "people"]);

const normalizeForStoplist = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, " ")
    .replace(/[-\u2013\u2014]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeValue = (value: string): string => {
  const normalized = normalizeForStoplist(value);
  if (!normalized) return "";
  return normalized.replace(/^[^a-z0-9]+/g, "").replace(/[^a-z0-9]+$/g, "");
};

const TOKEN_EDGE_PUNCT = /^[^a-z0-9]+|[^a-z0-9]+$/gi;

const stripEdgePunctuation = (value: string): string => value.replace(TOKEN_EDGE_PUNCT, "");

const normalizeTokenForLookup = (value: string): string => normalizeForStoplist(stripEdgePunctuation(value));

const normalizeTokenForStopword = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const shouldJoinEntity = (head: string, next: string): boolean => {
  const normalizedHead = normalizeTokenForStopword(head);
  const normalizedNext = normalizeTokenForStopword(next);
  if (!normalizedHead || !normalizedNext) return false;
  if (normalizedHead === "hepatitis" && /^[abc]$/.test(normalizedNext)) return true;
  if (normalizedHead === "vitamin" && /^[abcdk]$/.test(normalizedNext)) return true;
  if (normalizedHead === "type" && /^[0-9]$/.test(normalizedNext)) return true;
  if (normalizedHead === "stage" && /^[0-9]$/.test(normalizedNext)) return true;
  return false;
};

const CANONICAL_TOKEN_REGEX = /[^a-z0-9]+/g;

const normalizeCanonicalToken = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(CANONICAL_TOKEN_REGEX, "");

const normalizeAliasKey = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isStopwordToken = (token: string): boolean => {
  const lookup = normalizeTokenForLookup(token);
  if (!lookup) return true;
  if (isArticleOrPreposition(lookup)) return true;
  if (INLINE_STOPWORDS.has(lookup) || META_STOPWORDS.has(lookup)) return true;
  return false;
};

/**
 * Extract meaningful tokens from a raw string, skipping stopwords.
 *
 * @param raw - Raw input string.
 * @returns Filtered token list.
 */
export function extractMeaningfulTokens(raw: string): string[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const withoutMulti = trimmed.replace(MULTIWORD_PREPOSITION_REGEX, " ");
  const compact = withoutMulti.replace(/\s+/g, " ").trim();
  if (!compact) return [];
  const rawTokens = compact.split(" ");
  const joined: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const current = stripEdgePunctuation(rawTokens[i]);
    if (!current) continue;
    const nextRaw = rawTokens[i + 1];
    const next = nextRaw ? stripEdgePunctuation(nextRaw) : "";
    if (next && shouldJoinEntity(current, next)) {
      joined.push(`${current} ${next}`);
      i += 1;
      continue;
    }
    joined.push(current);
  }
  const results: string[] = [];
  for (const token of joined) {
    const normalized = normalizeTokenForStopword(token);
    if (!normalized) continue;
    if (isArticleOrPreposition(normalized)) continue;
    if (INLINE_STOPWORDS.has(normalized) || META_STOPWORDS.has(normalized)) continue;
    results.push(token);
  }
  return results;
}

/**
 * Build a canonical key for a prompt by sorting normalized tokens.
 *
 * @param cleanedPrompt - Cleaned prompt text.
 * @returns Canonical key string (tokens joined by "|").
 */
export function buildCanonicalPromptKey(cleanedPrompt: string): string {
  if (typeof cleanedPrompt !== "string") return "";
  const tokens = cleanedPrompt.split(/\s+/).filter(Boolean);
  const normalizedTokens: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeCanonicalToken(token);
    if (!normalized) continue;
    normalizedTokens.push(normalized);
  }
  if (!normalizedTokens.length) return "";
  normalizedTokens.sort((a, b) => a.localeCompare(b));
  return normalizedTokens.join("|");
}

/**
 * Build a list of alias phrases from a cleaned prompt.
 *
 * @param cleanedPrompt - Cleaned prompt text.
 * @param maxAliases - Maximum number of aliases to return.
 * @returns Alias list (best-effort).
 */
export function buildPromptAliases(cleanedPrompt: string, maxAliases = 5): string[] {
  if (typeof cleanedPrompt !== "string") return [];
  const tokens = cleanedPrompt
    .split(/\s+/)
    .map(token => stripEdgePunctuation(token))
    .filter(Boolean);
  if (!tokens.length || maxAliases <= 0) return [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  const addAlias = (phrase: string) => {
    const key = normalizeAliasKey(phrase);
    if (!key || seen.has(key)) return;
    seen.add(key);
    aliases.push(phrase);
  };
  for (let i = 0; i < tokens.length; i += 1) {
    if (aliases.length >= maxAliases) break;
    const tri = tokens.slice(i, i + 3);
    if (tri.length === 3 && tri.every(token => !isStopwordToken(token))) {
      addAlias(tri.join(" "));
    }
    if (aliases.length >= maxAliases) break;
    const bi = tokens.slice(i, i + 2);
    if (bi.length === 2 && bi.every(token => !isStopwordToken(token))) {
      addAlias(bi.join(" "));
    }
  }
  return aliases.slice(0, maxAliases);
}

/**
 * Merge existing aliases with new ones, honoring a maximum length.
 *
 * @param existing - Existing alias list.
 * @param incoming - Incoming alias list.
 * @param maxAliases - Maximum aliases to keep.
 * @returns Merged alias list.
 */
export function mergeAliasList(existing: string[], incoming: string[], maxAliases = 5): string[] {
  const merged: string[] = Array.isArray(existing) ? existing.slice(0, maxAliases) : [];
  const seen = new Set<string>(merged.map(alias => normalizeAliasKey(alias)).filter(Boolean));
  for (const alias of incoming || []) {
    if (merged.length >= maxAliases) break;
    const key = normalizeAliasKey(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(alias);
  }
  return merged.slice(0, maxAliases);
}

/**
 * Select a display phrase from aliases, preferring longer phrases.
 *
 * @param aliases - Alias list.
 * @param fallback - Fallback phrase when aliases are empty.
 * @returns Selected display phrase.
 */
export function selectDisplayPhrase(aliases: string[], fallback: string): string {
  const safeFallback = typeof fallback === "string" ? fallback.trim() : "";
  if (!Array.isArray(aliases) || !aliases.length) return safeFallback;
  const sorted = aliases
    .slice()
    .sort((a, b) => {
      const aCount = a.trim().split(/\s+/).filter(Boolean).length;
      const bCount = b.trim().split(/\s+/).filter(Boolean).length;
      if (aCount !== bCount) return bCount - aCount;
      return a.localeCompare(b);
    });
  return sorted[0] || safeFallback;
}

/**
 * Remove stopwords while preserving original token order.
 *
 * @param raw - Raw prompt text.
 * @returns Cleaned prompt string.
 */
export function cleanPromptPreserveOrder(raw: string): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withoutMulti = trimmed.replace(MULTIWORD_PREPOSITION_REGEX, " ");
  const compact = withoutMulti.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const rawTokens = compact.split(" ");
  const kept: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const token = rawTokens[i];
    if (!token) continue;
    let candidate = token;
    let skip = 0;
    const nextRaw = rawTokens[i + 1];
    if (nextRaw) {
      const currentJoin = stripEdgePunctuation(token);
      const nextJoin = stripEdgePunctuation(nextRaw);
      if (currentJoin && nextJoin && shouldJoinEntity(currentJoin, nextJoin)) {
        candidate = `${token} ${nextRaw}`;
        skip = 1;
      }
    }
    const lookup = normalizeTokenForLookup(candidate);
    if (!lookup) {
      i += skip;
      continue;
    }
    if (isArticleOrPreposition(lookup)) {
      i += skip;
      continue;
    }
    if (INLINE_STOPWORDS.has(lookup) || META_STOPWORDS.has(lookup)) {
      i += skip;
      continue;
    }
    kept.push(candidate);
    i += skip;
  }
  return kept.join(" ").trim();
}

const normalizeTopicKey = (value: string): string => normalizeTokenForStopword(value).replace(/\s+/g, " ").trim();

const isTrivialTopic = (value: string): boolean => {
  const normalized = normalizeTopicKey(value);
  if (!normalized) return true;
  const compact = normalized.replace(/\s+/g, "");
  return compact.length <= 1;
};

const buildTopicPhrases = (tokens: string[], maxTopics = 5): string[] => {
  if (!Array.isArray(tokens) || !tokens.length || maxTopics <= 0) return [];
  const candidates: string[] = [];
  const addNgrams = (size: number) => {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const slice = tokens.slice(i, i + size);
      if (!slice.length) continue;
      candidates.push(slice.join(" "));
    }
  };
  addNgrams(3);
  addNgrams(2);
  addNgrams(1);
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const phrase of candidates) {
    if (isTrivialTopic(phrase)) continue;
    const key = normalizeTopicKey(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    topics.push(phrase);
    if (topics.length >= maxTopics) break;
  }
  return topics;
};

/**
 * Clean a prompt and derive candidate topic phrases.
 *
 * @param raw - Raw prompt text.
 * @returns Cleaned text plus derived topic phrases.
 */
export function cleanPromptToSentence(raw: string): { cleaned: string; topics: string[] } {
  if (typeof raw !== "string") return { cleaned: "", topics: [] };
  const cleaned = cleanPromptPreserveOrder(raw);
  const tokens = extractMeaningfulTokens(raw);
  return { cleaned, topics: buildTopicPhrases(tokens) };
}

/**
 * Remove articles and prepositions from a string.
 *
 * @param input - Raw input string.
 * @returns Filtered string.
 */
export function removeArticlesAndPrepositionsFromString(input: string): string {
  const normalized = normalizeForStoplist(input);
  if (!normalized) return "";
  const withoutMulti = normalized.replace(MULTIWORD_PREPOSITION_REGEX, " ");
  const tokens = withoutMulti.split(/\s+/).filter(Boolean);
  const filtered = tokens
    .map(token => normalizeValue(token))
    .filter(token => token && !isArticleOrPreposition(token) && !INLINE_STOPWORDS.has(token));
  return filtered.join(" ");
}

/**
 * Build a weight map from metadata values.
 *
 * @param values - List of metadata strings.
 * @returns Weight map keyed by normalized token.
 */
export function buildMetaWeights(values: string[]): MetaWeights {
  const weights: MetaWeights = {};
  for (const value of values) {
    const normalized = normalizeValue(value);
    if (!normalized) continue;
    if (isArticleOrPreposition(normalized)) continue;
    weights[normalized] = (weights[normalized] ?? 0) + 1;
  }
  return weights;
}

/**
 * Zero out weights for stopwords/prepositions.
 *
 * @param weights - Weight map to sanitize.
 * @returns New weight map with stopwords zeroed.
 */
export function zeroOutStopMeta(weights: MetaWeights): MetaWeights {
  const result: MetaWeights = {};
  for (const key of Object.keys(weights)) {
    const normalizedKey = normalizeValue(key);
    const isStop = !normalizedKey || isArticleOrPreposition(normalizedKey) || INLINE_STOPWORDS.has(normalizedKey);
    result[key] = isStop ? 0 : weights[key];
  }
  return result;
}

/**
 * Extract the top non-stopword keys from a weight map.
 *
 * @param weights - Weight map to inspect.
 * @param limit - Maximum number of keys to return.
 * @returns Sorted list of metadata keys.
 */
export function extractNonStopMeta(weights: MetaWeights, limit: number): string[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  return Object.keys(weights)
    .filter((key) => weights[key] > 0)
    .sort((a, b) => {
      const delta = weights[b] - weights[a];
      return delta !== 0 ? delta : a.localeCompare(b);
    })
    .slice(0, safeLimit);
}

/**
 * Extract a flat list of meaningful metadata tokens from values.
 *
 * @param values - Input metadata strings.
 * @param limit - Maximum number of tokens to return.
 * @returns Flattened list of tokens.
 */
export function filterMetadata(values: string[], limit: number): string[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (!safeLimit) return [];
  const results: string[] = [];
  for (const value of values || []) {
    if (typeof value !== "string") continue;
    const tokens = extractMeaningfulTokens(value);
    for (const token of tokens) {
      results.push(token);
      if (results.length >= safeLimit) return results;
    }
  }
  return results;
}
