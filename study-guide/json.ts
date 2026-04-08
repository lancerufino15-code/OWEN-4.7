const MACHINE_STUDY_GUIDE_STEP_A_TRUNCATION_MAX_RETRIES = 2;

const STEP_A1_JSON_EXTRACT_FAILED = "STEP_A1_JSON_EXTRACT_FAILED";
const STEP_A1_JSON_PARSE_FAILED = "STEP_A1_JSON_PARSE_FAILED";
const STEP_A1_SCHEMA_VALIDATION_FAILED = "STEP_A1_SCHEMA_VALIDATION_FAILED";

type JsonExtractionMethod = "first_object" | "raw_fallback" | "none";

type JsonParseAttempt<T> = {
  ok: boolean;
  value?: T;
  reason?: "no-json" | "parse" | "validation";
  extraction: JsonExtractionMethod;
  candidate?: string;
  usedMinimalRepair: boolean;
  repairMeta?: { appendedClosers: string; usedReextract: boolean };
  validationErrors?: string[];
};

type StepAJsonErrorCode =
  | typeof STEP_A1_JSON_EXTRACT_FAILED
  | typeof STEP_A1_JSON_PARSE_FAILED
  | typeof STEP_A1_SCHEMA_VALIDATION_FAILED;

type StepAParseAttempt<T> =
  | {
      ok: true;
      value: T;
      extraction: JsonExtractionMethod;
      candidate: string;
    }
  | {
      ok: false;
      reason: "no-json" | "parse" | "validation" | "truncated";
      extraction: JsonExtractionMethod;
      candidate?: string;
      validationErrors?: string[];
    };

type JsonTokenAnalysis = {
  openCurly: number;
  closeCurly: number;
  openSquare: number;
  closeSquare: number;
  stack: Array<"{" | "[">;
  inString: boolean;
};

export function applyStudyGuidePromptTemplate(template: string, replacements: Record<string, string>): string {
  let output = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    output = output.split(placeholder).join(value);
  }
  return output;
}

export function truncateAtHtmlEnd(
  text: string,
): { ok: true; html: string } | { ok: false; error: string } {
  const marker = "</html>";
  const lower = (text || "").toLowerCase();
  const idx = lower.indexOf(marker);
  if (idx === -1) {
    return {
      ok: false,
      error: "Model output missing </html>. Study guide generation failed.",
    };
  }
  const endIdx = idx + marker.length;
  return { ok: true, html: (text || "").slice(0, endIdx) };
}

function hasUnescapedQuoteAhead(text: string, start: number): boolean {
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") return true;
  }
  return false;
}

function repairInvalidJsonEscapes(raw: string): string {
  if (!raw) return raw;
  const validEscapes = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t", "u"]);
  let inString = false;
  let output = "";

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (!inString) {
      if (ch === "\"") inString = true;
      output += ch;
      continue;
    }
    if (ch === "\"") {
      inString = false;
      output += ch;
      continue;
    }
    if (ch === "\\") {
      const next = raw[i + 1];
      if (!next) {
        output += "\\\\";
        continue;
      }
      if (next === "\"" && !hasUnescapedQuoteAhead(raw, i + 2)) {
        output += "\\\\";
        continue;
      }
      if (validEscapes.has(next)) {
        output += `\\${next}`;
        i += 1;
        continue;
      }
      output += "\\\\";
      continue;
    }
    output += ch;
  }

  return output;
}

function tryParseJson<T>(raw: string): T | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(repairInvalidJsonEscapes(trimmed)) as T;
  } catch {
    return null;
  }
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function stripMarkdownFences(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed.startsWith("```")) return raw;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && typeof fenced[1] === "string") {
    return fenced[1].trim();
  }
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd === -1) return raw;
  const firstLine = trimmed.slice(0, firstLineEnd).trim();
  if (!firstLine.startsWith("```")) return raw;
  let body = trimmed.slice(firstLineEnd + 1);
  const closingIndex = body.lastIndexOf("```");
  if (closingIndex !== -1) {
    body = body.slice(0, closingIndex);
  }
  return body.trim();
}

export function extractFirstJsonObject(raw: string): string | null {
  const text = raw || "";
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depthCurly = 0;
  let depthSquare = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escapeNext = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depthCurly += 1;
      continue;
    }
    if (ch === "}") {
      depthCurly -= 1;
      if (depthCurly === 0 && depthSquare === 0) {
        return text.slice(start, i + 1);
      }
      continue;
    }
    if (ch === "[") {
      depthSquare += 1;
      continue;
    }
    if (ch === "]") {
      depthSquare -= 1;
      continue;
    }
  }
  return null;
}

function analyzeJsonTokens(raw: string): JsonTokenAnalysis {
  let openCurly = 0;
  let closeCurly = 0;
  let openSquare = 0;
  let closeSquare = 0;
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escapeNext = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      openCurly += 1;
      stack.push("{");
      continue;
    }
    if (ch === "[") {
      openSquare += 1;
      stack.push("[");
      continue;
    }
    if (ch === "}") {
      closeCurly += 1;
      if (stack[stack.length - 1] === "{") stack.pop();
      continue;
    }
    if (ch === "]") {
      closeSquare += 1;
      if (stack[stack.length - 1] === "[") stack.pop();
      continue;
    }
  }
  return { openCurly, closeCurly, openSquare, closeSquare, stack, inString };
}

function looksTruncatedJson(raw: string): boolean {
  const stripped = stripMarkdownFences(raw);
  const trimmed = stripped.trim();
  if (!trimmed) return false;
  const extracted = extractFirstJsonObject(trimmed);
  const candidate = (extracted ?? trimmed).trim();
  if (!candidate || !candidate.includes("{")) return false;
  const analysis = analyzeJsonTokens(candidate);
  if (analysis.inString) return true;
  if (analysis.stack.length) return true;
  if (analysis.openCurly > analysis.closeCurly || analysis.openSquare > analysis.closeSquare) return true;
  const lastChar = candidate[candidate.length - 1];
  if (lastChar === ",") return true;
  if (lastChar === "]" && analysis.openCurly > analysis.closeCurly) return true;
  return lastChar !== "}" && lastChar !== "]";
}

function extractJsonCandidate(raw: string, strict: boolean): { candidate: string | null; extraction: JsonExtractionMethod } {
  const stripped = stripMarkdownFences(raw);
  const extracted = extractFirstJsonObject(stripped);
  if (extracted) return { candidate: extracted, extraction: "first_object" };
  if (strict) return { candidate: null, extraction: "none" };
  return { candidate: stripped.trim(), extraction: "raw_fallback" };
}

function parseJsonCandidate<T>(
  raw: string,
  opts: { strictExtraction: boolean; validate?: (value: T) => string[] },
): JsonParseAttempt<T> {
  const { candidate, extraction } = extractJsonCandidate(raw, opts.strictExtraction);
  if (!candidate) {
    return { ok: false, reason: "no-json", extraction, usedMinimalRepair: false };
  }
  const cleaned = candidate.trim();
  const parsed = tryParseJson<T>(cleaned);
  if (parsed) {
    const validationErrors = opts.validate ? opts.validate(parsed) : [];
    if (!validationErrors.length) {
      return { ok: true, value: parsed, extraction, candidate: cleaned, usedMinimalRepair: false };
    }
    return {
      ok: false,
      reason: "validation",
      extraction,
      candidate: cleaned,
      usedMinimalRepair: false,
      validationErrors,
    };
  }
  const minimal = repairJsonMinimal(cleaned, raw);
  if (minimal) {
    const repairedParsed = tryParseJson<T>(minimal.repaired);
    if (repairedParsed) {
      const validationErrors = opts.validate ? opts.validate(repairedParsed) : [];
      if (!validationErrors.length) {
        return {
          ok: true,
          value: repairedParsed,
          extraction,
          candidate: minimal.repaired,
          usedMinimalRepair: true,
          repairMeta: { appendedClosers: minimal.appendedClosers, usedReextract: minimal.usedReextract },
        };
      }
      return {
        ok: false,
        reason: "validation",
        extraction,
        candidate: minimal.repaired,
        usedMinimalRepair: true,
        repairMeta: { appendedClosers: minimal.appendedClosers, usedReextract: minimal.usedReextract },
        validationErrors,
      };
    }
  }
  return {
    ok: false,
    reason: "parse",
    extraction,
    candidate: minimal?.repaired || cleaned,
    usedMinimalRepair: Boolean(minimal),
    repairMeta: minimal
      ? { appendedClosers: minimal.appendedClosers, usedReextract: minimal.usedReextract }
      : undefined,
  };
}

function tailPreview(raw: string, max = 240): string {
  const trimmed = (raw || "").trim();
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}

function mapStepAErrorCode(reason?: StepAParseAttempt<unknown>["reason"]): StepAJsonErrorCode | undefined {
  switch (reason) {
    case "no-json":
      return STEP_A1_JSON_EXTRACT_FAILED;
    case "parse":
      return STEP_A1_JSON_PARSE_FAILED;
    case "validation":
      return STEP_A1_SCHEMA_VALIDATION_FAILED;
    default:
      return undefined;
  }
}

function buildStepAJsonError(
  code: StepAJsonErrorCode,
  label: string,
  validationErrors?: string[],
): Error {
  const messageMap: Record<StepAJsonErrorCode, string> = {
    [STEP_A1_JSON_EXTRACT_FAILED]: `Study guide step ${label} JSON extract failed.`,
    [STEP_A1_JSON_PARSE_FAILED]: `Study guide step ${label} JSON parse failed.`,
    [STEP_A1_SCHEMA_VALIDATION_FAILED]: `Study guide step ${label} JSON schema validation failed.`,
  };
  const error = new Error(`${code}: ${messageMap[code]}`);
  (error as any).code = code;
  if (validationErrors?.length) {
    (error as any).validationErrors = validationErrors;
  }
  return error;
}

function parseStepAJsonCandidate<T>(raw: string, validate?: (value: T) => string[]): StepAParseAttempt<T> {
  const stripped = stripMarkdownFences(raw);
  const extracted = extractFirstJsonObject(stripped);
  if (!extracted) {
    if (looksTruncatedJson(stripped)) {
      return { ok: false, reason: "truncated", extraction: "none" };
    }
    return { ok: false, reason: "no-json", extraction: "none" };
  }
  const candidate = extracted.trim();
  const parsed = tryParseJson<T>(candidate);
  if (!parsed) {
    return { ok: false, reason: "parse", extraction: "first_object", candidate };
  }
  const validationErrors = validate ? validate(parsed) : [];
  if (validationErrors.length) {
    return {
      ok: false,
      reason: "validation",
      extraction: "first_object",
      candidate,
      validationErrors,
    };
  }
  return { ok: true, value: parsed, extraction: "first_object", candidate };
}

export function parseStudyGuideJson<T>(raw: string, label: string): T {
  const { candidate } = extractJsonCandidate(raw, true);
  const trimmed = (candidate || "").trim();
  if (!trimmed) {
    throw new Error(`Study guide step ${label} returned invalid JSON. No JSON object found.`);
  }
  const parsed = tryParseJson<T>(trimmed);
  if (parsed) return parsed;
  const tail = trimmed.slice(-500);
  throw new Error(`Study guide step ${label} returned invalid JSON. Tail: ${tail}`);
}

export function repairJsonMinimal(
  jsonLike: string,
  originalRaw?: string,
): { repaired: string; appendedClosers: string; usedReextract: boolean } | null {
  if (!jsonLike) return null;
  let cleaned = stripBom(jsonLike).trim();
  const start = cleaned.indexOf("{");
  if (start !== -1) cleaned = cleaned.slice(start);
  const end = cleaned.lastIndexOf("}");
  if (end !== -1) cleaned = cleaned.slice(0, end + 1);
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  cleaned = repairInvalidJsonEscapes(cleaned);

  let analysis = analyzeJsonTokens(cleaned);
  const hasExcessClosers =
    analysis.closeCurly > analysis.openCurly || analysis.closeSquare > analysis.openSquare;
  let usedReextract = false;
  if (hasExcessClosers && originalRaw) {
    const reextracted = extractFirstJsonObject(originalRaw);
    if (reextracted) {
      cleaned = reextracted.trim().replace(/,\s*([}\]])/g, "$1");
      cleaned = repairInvalidJsonEscapes(cleaned);
      usedReextract = true;
      analysis = analyzeJsonTokens(cleaned);
    }
  }
  if (analysis.closeCurly > analysis.openCurly || analysis.closeSquare > analysis.openSquare) {
    return null;
  }
  let appendedClosers = "";
  if (analysis.openCurly > analysis.closeCurly || analysis.openSquare > analysis.closeSquare) {
    appendedClosers = analysis.stack
      .slice()
      .reverse()
      .map((token) => (token === "{" ? "}" : "]"))
      .join("");
    cleaned += appendedClosers;
  }
  return { repaired: cleaned, appendedClosers, usedReextract };
}

export async function parseStudyGuideJsonWithRepair<T>(
  raw: string,
  label: string,
  repair: (raw: string) => Promise<string>,
  opts?: { strictExtraction?: boolean; validate?: (value: T) => string[] },
): Promise<T> {
  const strictExtraction = opts?.strictExtraction ?? false;
  const initial = parseJsonCandidate<T>(raw, { strictExtraction, validate: opts?.validate });
  if (initial.ok) return initial.value as T;
  console.warn("[machine.studyGuide] step=%s json=invalid; attempting repair", label);
  const repairInput = initial.candidate || raw;
  const repairedRaw = await repair(repairInput);
  const repaired = parseJsonCandidate<T>(repairedRaw, { strictExtraction, validate: opts?.validate });
  if (repaired.ok) return repaired.value as T;
  console.warn(
    "[machine.studyGuide] step=%s json=repair_failed reason=%s extract=%s tail=%s",
    label,
    repaired.reason,
    repaired.extraction,
    tailPreview(repaired.candidate || repairedRaw),
  );
  throw new Error(`Study guide step ${label} repair failed.`);
}

export async function parseStudyGuideJsonWithRepairAndRetry<T>(opts: {
  raw: string;
  label: string;
  retry: () => Promise<string>;
  validate?: (value: T) => string[];
  fallback?: () => T;
  maxTruncationRetries?: number;
}): Promise<T> {
  const maxRetries =
    typeof opts.maxTruncationRetries === "number"
      ? opts.maxTruncationRetries
      : MACHINE_STUDY_GUIDE_STEP_A_TRUNCATION_MAX_RETRIES;
  let attempt = parseStepAJsonCandidate<T>(opts.raw, opts.validate);
  console.log("[machine.studyGuide] step=%s json=extract method=%s", opts.label, attempt.extraction);
  if (attempt.ok) {
    console.log("[machine.studyGuide] step=%s json=parse ok", opts.label);
    return attempt.value as T;
  }
  if (attempt.reason === "validation" && attempt.validationErrors?.length) {
    console.warn("[machine.studyGuide] step=%s json=validation_failed errors=%o", opts.label, attempt.validationErrors);
  }
  if (attempt.reason !== "truncated") {
    console.warn(
      "[machine.studyGuide] step=%s json=parse_failed reason=%s extract=%s tail=%s",
      opts.label,
      attempt.reason,
      attempt.extraction,
      tailPreview(attempt.candidate || opts.raw),
    );
    const code = mapStepAErrorCode(attempt.reason);
    if (!code) {
      throw new Error(`Study guide step ${opts.label} JSON parse failed.`);
    }
    throw buildStepAJsonError(code, opts.label, attempt.validationErrors);
  }

  let retries = 0;
  let retryRaw = opts.raw;
  while (attempt.reason === "truncated" && retries < maxRetries) {
    retries += 1;
    console.warn("[machine.studyGuide] step=%s json=truncated; retrying", opts.label);
    console.warn("[machine.studyGuide] step=%s json=retry_triggered reason=truncation", opts.label);
    retryRaw = await opts.retry();
    attempt = parseStepAJsonCandidate<T>(retryRaw, opts.validate);
    if (attempt.ok) {
      console.log("[machine.studyGuide] step=%s json=retry ok", opts.label);
      return attempt.value as T;
    }
    if (attempt.reason === "validation" && attempt.validationErrors?.length) {
      console.warn("[machine.studyGuide] step=%s json=retry_validation_failed errors=%o", opts.label, attempt.validationErrors);
    }
    if (attempt.reason !== "truncated") {
      console.warn(
        "[machine.studyGuide] step=%s json=retry_failed reason=%s extract=%s tail=%s",
        opts.label,
        attempt.reason,
        attempt.extraction,
        tailPreview(attempt.candidate || retryRaw),
      );
      const code = mapStepAErrorCode(attempt.reason);
      if (!code) {
        throw new Error(`Study guide step ${opts.label} JSON parse failed.`);
      }
      throw buildStepAJsonError(code, opts.label, attempt.validationErrors);
    }
  }

  console.warn("[machine.studyGuide] step=%s json=retry_failed reason=truncated tail=%s", opts.label, tailPreview(retryRaw));
  if (opts.fallback) {
    console.warn("[machine.studyGuide] step=%s json=fallback_used reason=truncation", opts.label);
    return opts.fallback();
  }
  throw buildStepAJsonError(STEP_A1_JSON_PARSE_FAILED, opts.label);
}
