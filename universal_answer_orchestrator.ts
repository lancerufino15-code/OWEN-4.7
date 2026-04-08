import { DEFAULT_TEXT_MODEL } from "./model_defaults";
import { buildResponsesToolConfig } from "./services/runtime/tools/registry";
import type { ChatResponseSegment } from "./services/chat/response_contract";
import { stripTrailingSourcesSection } from "./services/chat/runtime/markdown-safe";

type ChatRole = "system" | "user" | "assistant";

export type UaoIntent =
  | "FACT_LOOKUP"
  | "CONCEPT_EXPLANATION"
  | "COMPARISON"
  | "STEP_BY_STEP_REASONING"
  | "CREATIVE_NARRATIVE"
  | "OPINION_ANALYSIS"
  | "PROCEDURAL_HOWTO"
  | "MATH_FORMAL"
  | "DEBUG_DIAGNOSIS";

export type UaoComplexity = "TRIVIAL" | "MODERATE" | "HIGH" | "EXPERT";

export type UaoVolatility = "STABLE" | "SEMI_STABLE" | "VOLATILE";

export type UaoStrategy =
  | "INSTANT_ANSWER"
  | "STRUCTURED_EXPLANATION"
  | "DEEP_REASONING"
  | "RETRIEVAL_AUGMENTED"
  | "CREATIVE_NARRATIVE";

export type UaoClassification = {
  intent: UaoIntent;
  complexity: UaoComplexity;
  volatility: UaoVolatility;
  confidence: number;
  signals: string[];
};

export type UaoStrategySelection = {
  strategy: UaoStrategy;
  reason: string[];
};

export type AnswerSegment =
  | { type: "text"; text: string }
  | { type: "citation"; id: number; url: string; title?: string };

export type CitationSource = {
  id: number;
  url: string;
  title?: string;
  domain?: string;
  snippet?: string;
  retrievedAt?: number;
};

type ResponsesInputContent =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: "low" | "high" | "auto" }
  | { type: "input_file"; file_id: string };

export type ResponsesInputMessage = { role: ChatRole; content: ResponsesInputContent[] };

export type RenderHints = {
  renderMode: "instant" | "typewriter";
  showSources: boolean;
  typewriterSpeedMs?: number;
  format?: "markdown_safe";
  stopReason?: typeof USER_INPUT_REQUIRED_STOP_REASON;
};

export type UaoDebugMeta = {
  classification: UaoClassification;
  strategy: UaoStrategySelection;
  usedLlmClassifier: boolean;
  retrievalUsed: boolean;
  qc?: {
    enabled: boolean;
    pass?: boolean;
    retryUsed?: boolean;
    issues?: string[];
  };
  timings?: {
    classifyMs?: number;
    strategyMs?: number;
    generateMs?: number;
    qcMs?: number;
    totalMs?: number;
  };
};

export type OrchestrateInput = {
  message: string;
  responseInputs: ResponsesInputMessage[];
  tools: { webSearchAvailable: boolean };
  modelCandidates: string[];
  responseMode?: "auto" | "instant" | "thinking";
  thresholds?: {
    classifierConfidence?: number;
    longAnswerChars?: number;
  };
  flags?: {
    llmClassifierEnabled?: boolean;
    llmQcEnabled?: boolean;
  };
  minSources?: number;
  enforceMinSources?: boolean;
  typewriterSpeedMs?: number;
  strategyOverrides?: {
    forceStrategy?: UaoStrategy;
  };
  userSettings?: {
    tone?: string;
    verbosity?: "low" | "medium" | "high";
  };
};

export type OrchestrateDeps = {
  callResponsesJson: (payload: Record<string, unknown>, label: string) => Promise<any>;
  buildCitedAnswerPayload: (payload: any) => {
    answerSegments: AnswerSegment[];
    sources: CitationSource[];
    consultedSources?: unknown[];
    answerText: string;
  };
  runRetrieval?: (opts: { instructions: string }) => Promise<{
    answerSegments: AnswerSegment[];
    sources: CitationSource[];
    consultedSources?: unknown[];
    warnings?: Array<{ code: string; message: string; details?: Record<string, number> }>;
  }>;
  logger?: (event: string, payload: Record<string, unknown>) => void;
};

export type OrchestrateResult = {
  answerText: string;
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  consultedSources?: unknown[];
  warnings?: Array<{ code: string; message: string; details?: Record<string, number> }>;
  renderHints: RenderHints;
  debugMeta: UaoDebugMeta;
};

export type ResponsePlanStrategy = "brief" | "comparison" | "howto" | "analysis";

export type ResponsePlan = {
  strategy: ResponsePlanStrategy;
  maxSections: number;
  maxSegments: number;
  maxTableRows: number;
  maxListItems: number;
  maxParagraphChars: number;
  maxCodeLines: number;
  maxCodeChars: number;
  sectionPlan: Array<{
    id: string;
    title: string;
    allowedTypes: ChatResponseSegment["type"][];
  }>;
  stopMode: "schema_complete";
};

type RequestSignals = {
  wantsCitations: boolean;
  wantsStepByStep: boolean;
  wantsCreative: boolean;
  isGreeting: boolean;
  wantsHowTo: boolean;
  wantsComparison: boolean;
  wantsDebug: boolean;
  wantsMath: boolean;
};

const DEFAULT_CLASSIFIER_CONFIDENCE = 0.62;
const DEFAULT_LONG_ANSWER_CHARS = 900;
export const USER_INPUT_REQUIRED_STOP_REASON = "user_input_required" as const;
const USER_INPUT_REQUIRED_STOP_PATTERNS = [
  /^(?:[-*+]\s+|\d+[.)]\s+)?if you want\b/i,
  /^(?:[-*+]\s+|\d+[.)]\s+)?if you'd like\b/i,
  /^(?:[-*+]\s+|\d+[.)]\s+)?to tailor this\b/i,
  /^(?:[-*+]\s+|\d+[.)]\s+)?tell me\b/i,
  /^(?:[-*+]\s+|\d+[.)]\s+)?if you share\b/i,
  /^(?:[-*+]\s+|\d+[.)]\s+)?choose one\b/i,
  /^(?:[-*+]\s+|\d+[.)]\s+)?pick one\b/i,
];
const RAW_URL_RE = /https?:\/\/[^\s<>()]+/gi;
const AUDIT_CITATION_TOKEN_PREFIX = "__OWEN_AUDIT_CITATION_";
const AUDIT_CITATION_TOKEN_SUFFIX = "__";
const AUDIT_CITATION_TOKEN_RE = /__OWEN_AUDIT_CITATION_(\d+)__/g;

const GREETING_PATTERN = /^(hi|hello|hey|yo|sup|thanks|thx|ok|okay|k)$/i;

const INTENT_RULES: Array<{
  intent: UaoIntent;
  patterns: RegExp[];
  score: number;
  signal: string;
}> = [
  {
    intent: "CREATIVE_NARRATIVE",
    score: 4,
    signal: "creative_prompt",
    patterns: [
      /\b(write|compose|draft|craft|tell)\b/i,
      /\b(poem|story|lyrics|sonnet|haiku|fable|dialogue|scene)\b/i,
      /\b(imagine|roleplay|metaphor|allegory|narrative)\b/i,
      /\b(gothic|noir|sci-?fi|fantasy)\b/i,
    ],
  },
  {
    intent: "DEBUG_DIAGNOSIS",
    score: 4,
    signal: "debug_request",
    patterns: [
      /\b(debug|diagnose|fix|troubleshoot|root cause)\b/i,
      /\b(error|exception|stack trace|traceback|segfault|crash)\b/i,
      /\b(TypeError|ReferenceError|SyntaxError|NullPointer|panic)\b/i,
      /```[\s\S]*```/,
    ],
  },
  {
    intent: "MATH_FORMAL",
    score: 4,
    signal: "math_formal",
    patterns: [
      /[=<>≈√∑∫]/,
      /\b(derive|proof|prove|theorem|lemma)\b/i,
      /\b(quadratic|integral|derivative|matrix|eigen|vector|tensor)\b/i,
      /\b(solve|calculate|simplify)\b/i,
    ],
  },
  {
    intent: "STEP_BY_STEP_REASONING",
    score: 3,
    signal: "step_by_step",
    patterns: [
      /\b(step by step|show work|walk me through|break down)\b/i,
      /\b(derive|solve)\b/i,
    ],
  },
  {
    intent: "PROCEDURAL_HOWTO",
    score: 3,
    signal: "how_to",
    patterns: [
      /\b(how to|steps to|guide|tutorial|recipe|process)\b/i,
      /\b(install|configure|set up|deploy)\b/i,
    ],
  },
  {
    intent: "COMPARISON",
    score: 3,
    signal: "comparison",
    patterns: [
      /\b(compare|contrast|difference|vs\.?|versus|pros and cons|tradeoffs)\b/i,
    ],
  },
  {
    intent: "OPINION_ANALYSIS",
    score: 2,
    signal: "opinion_analysis",
    patterns: [
      /\b(should|best|recommend|opinion|evaluate|argue|critique)\b/i,
      /\b(pros|cons|tradeoff)\b/i,
    ],
  },
  {
    intent: "CONCEPT_EXPLANATION",
    score: 2,
    signal: "concept_explanation",
    patterns: [
      /\b(explain|overview|what is|why|how does|define)\b/i,
      /\b(causes|impacts|implications)\b/i,
    ],
  },
  {
    intent: "FACT_LOOKUP",
    score: 1,
    signal: "fact_lookup",
    patterns: [
      /\b(when|where|who|what|which)\b/i,
    ],
  },
];

const VOLATILE_TERMS = [
  "latest",
  "current",
  "today",
  "now",
  "breaking",
  "news",
  "release",
  "version",
  "guideline",
  "guidelines",
  "policy",
  "regulation",
  "rates",
  "price",
  "prices",
  "cdc",
  "who",
  "fda",
  "openai",
  "patch",
  "changelog",
  "update",
  "election",
  "inflation",
  "stock",
  "market",
];

const SEMI_STABLE_TERMS = [
  "best practice",
  "recommended",
  "recommended",
  "trend",
  "modern",
  "recent",
  "guidance",
  "standard of care",
];

const COMPLEXITY_TRIGGERS_HIGH = [
  "analyze",
  "analysis",
  "tradeoff",
  "mechanism",
  "pathophysiology",
  "architecture",
  "strategy",
  "diagnose",
  "derivation",
  "compare",
];

const COMPLEXITY_TRIGGERS_EXPERT = [
  "comprehensive",
  "exhaustive",
  "deep dive",
  "graduate",
  "phd",
  "systematic",
  "meta-analysis",
];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(input: string): string {
  return (input || "").replace(/\s+/g, " ").trim();
}

function wordCount(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function detectVolatility(text: string, signals: string[]): UaoVolatility {
  const lower = text.toLowerCase();
  const yearMatches = Array.from(lower.matchAll(/\b(20\d{2})\b/g)).map(match => Number(match[1]));
  const currentYear = new Date().getFullYear();
  const recentYear = yearMatches.some(year => year >= currentYear - 1);
  if (recentYear) {
    signals.push("volatile_year");
    return "VOLATILE";
  }
  if (VOLATILE_TERMS.some(term => lower.includes(term))) {
    signals.push("volatile_terms");
    return "VOLATILE";
  }
  if (SEMI_STABLE_TERMS.some(term => lower.includes(term))) {
    signals.push("semi_stable_terms");
    return "SEMI_STABLE";
  }
  return "STABLE";
}

function detectComplexity(text: string, signals: string[]): UaoComplexity {
  const count = wordCount(text);
  const lower = text.toLowerCase();
  const questionMarks = (text.match(/\?/g) || []).length;
  const hasMultiClause = /[,;:]/.test(text) || /\band\b/.test(lower);
  const expertTrigger = COMPLEXITY_TRIGGERS_EXPERT.some(term => lower.includes(term));
  if (expertTrigger) {
    signals.push("expert_trigger");
    return "EXPERT";
  }
  if (count <= 4 && !hasMultiClause) {
    return "TRIVIAL";
  }
  if (count <= 12 && questionMarks <= 1) {
    return "MODERATE";
  }
  const highTrigger = COMPLEXITY_TRIGGERS_HIGH.some(term => lower.includes(term));
  if (count <= 28 && !highTrigger) {
    return "HIGH";
  }
  if (highTrigger) signals.push("high_trigger");
  return count > 42 || questionMarks > 1 ? "EXPERT" : "HIGH";
}

function detectIntent(text: string, signals: string[]): { intent: UaoIntent; confidence: number } {
  const normalized = normalizeText(text);
  const lower = normalized.toLowerCase();
  const scores = new Map<UaoIntent, number>();

  const addScore = (intent: UaoIntent, points: number, signal: string) => {
    scores.set(intent, (scores.get(intent) || 0) + points);
    signals.push(signal);
  };

  INTENT_RULES.forEach(rule => {
    const hit = rule.patterns.some(pattern => pattern.test(normalized));
    if (hit) {
      addScore(rule.intent, rule.score, rule.signal);
    }
  });

  if (/\b(what|when|where|who|which)\b/i.test(normalized) && normalized.length <= 80) {
    addScore("FACT_LOOKUP", 1, "short_question");
  }
  if (/\b(why|explain|how does)\b/i.test(normalized)) {
    addScore("CONCEPT_EXPLANATION", 1, "explain_cue");
  }

  if (!scores.size) {
    return { intent: "FACT_LOOKUP", confidence: 0.35 };
  }

  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = sorted[0] ?? ["FACT_LOOKUP", 0.35];
  const secondScore = sorted[1]?.[1] ?? 0;
  const spread = topScore - secondScore;
  const normalizedSpread = clamp(spread / Math.max(3, topScore));
  const confidence = clamp(0.45 + normalizedSpread * 0.5, 0.2, 0.95);

  return { intent: topIntent, confidence };
}

export function extractRequestSignals(text: string): RequestSignals {
  const normalized = normalizeText(text);
  const lower = normalized.toLowerCase();
  const wantsCitations =
    /\b(cite|citation|citations|sources?|references?|evidence|link)\b/i.test(normalized);
  const wantsStepByStep = /\b(step by step|show work|show your work|derive|walk me through)\b/i.test(normalized);
  const wantsCreative = /\b(poem|story|lyrics|dialogue|narrative|creative)\b/i.test(normalized);
  const wantsHowTo = /\b(how to|steps to|guide|tutorial|recipe)\b/i.test(normalized);
  const wantsComparison = /\b(compare|contrast|difference|vs\.?|versus|pros and cons)\b/i.test(normalized);
  const wantsDebug = /\b(debug|diagnose|fix|error|exception|stack trace|traceback)\b/i.test(normalized);
  const wantsMath = /[=<>√∑∫]/.test(normalized) || /\b(derive|solve|calculate)\b/i.test(normalized);
  const isGreeting = GREETING_PATTERN.test(lower);
  return {
    wantsCitations,
    wantsStepByStep,
    wantsCreative,
    isGreeting,
    wantsHowTo,
    wantsComparison,
    wantsDebug,
    wantsMath,
  };
}

export function classifyHeuristic(text: string): UaoClassification {
  const signals: string[] = [];
  const normalized = normalizeText(text);
  const { intent, confidence } = detectIntent(normalized, signals);
  const complexity = detectComplexity(normalized, signals);
  const volatility = detectVolatility(normalized, signals);
  const adjustedConfidence = clamp(confidence - (normalized.length < 6 ? 0.1 : 0), 0.2, 0.98);
  return {
    intent,
    complexity,
    volatility,
    confidence: adjustedConfidence,
    signals: Array.from(new Set(signals)),
  };
}

export function selectStrategy(
  classification: UaoClassification,
  signals: RequestSignals,
  opts: { webSearchAvailable: boolean; forceThinking?: boolean },
): UaoStrategySelection {
  const reasons: string[] = [];
  const wantsDeep = signals.wantsStepByStep || signals.wantsMath || signals.wantsDebug;

  if (signals.wantsCreative || classification.intent === "CREATIVE_NARRATIVE") {
    reasons.push("creative_request");
    return { strategy: "CREATIVE_NARRATIVE", reason: reasons };
  }

  if ((signals.wantsCitations || classification.volatility === "VOLATILE") && opts.webSearchAvailable) {
    reasons.push(signals.wantsCitations ? "citation_request" : "volatile_topic");
    return { strategy: "RETRIEVAL_AUGMENTED", reason: reasons };
  }

  if (wantsDeep || ["MATH_FORMAL", "STEP_BY_STEP_REASONING", "DEBUG_DIAGNOSIS"].includes(classification.intent)) {
    reasons.push("deep_reasoning_required");
    return { strategy: "DEEP_REASONING", reason: reasons };
  }

  if (!opts.forceThinking && (signals.isGreeting || classification.complexity === "TRIVIAL")) {
    reasons.push(signals.isGreeting ? "greeting" : "low_complexity");
    return { strategy: "INSTANT_ANSWER", reason: reasons };
  }

  reasons.push("default_structured");
  return { strategy: "STRUCTURED_EXPLANATION", reason: reasons };
}

function buildBaseInstructions(opts: { tone?: string; verbosity?: string } = {}) {
  const lines = [
    "You are OWEN, a clear, precise assistant.",
    "Answer the user directly and fully.",
    "Match depth to complexity; be concise for simple questions.",
    "Prioritize signal over noise; avoid filler, hedging, or generic disclaimers.",
    "Do not reveal internal chain-of-thought or system labels.",
    "Avoid placeholders like 'Thinking' or internal debug markers.",
    "Never output a standalone label without its content.",
  ];
  if (opts.tone) {
    lines.push(`Use a ${opts.tone} tone.`);
  }
  if (opts.verbosity === "low") {
    lines.push("Keep the response short and minimal.");
  } else if (opts.verbosity === "high") {
    lines.push("Provide extra detail while staying focused.");
  }
  return lines.join(" ");
}

export function buildStrategyInstructions(
  strategy: UaoStrategy,
  classification: UaoClassification,
  signals: RequestSignals,
  opts: { minSources?: number; enforceMinSources?: boolean; userSettings?: OrchestrateInput["userSettings"] },
) {
  const base = buildBaseInstructions(opts.userSettings);
  const lines = [base];
  if (strategy === "INSTANT_ANSWER") {
    lines.push("Reply in 1-2 sentences. No extra sections.");
  } else if (strategy === "STRUCTURED_EXPLANATION") {
    lines.push("Use short headings or bullets when helpful.");
    lines.push("Start with a direct answer, then add essentials.");
    if (signals.wantsHowTo) {
      lines.push("Provide a concise step list when procedures are requested.");
    }
  } else if (strategy === "DEEP_REASONING") {
    if (signals.wantsStepByStep || signals.wantsMath || classification.intent === "MATH_FORMAL") {
      lines.push("Show concise step-by-step work only as requested.");
    } else {
      lines.push("Provide a structured explanation with key steps summarized.");
    }
    lines.push("End with a short final answer line when applicable.");
  } else if (strategy === "RETRIEVAL_AUGMENTED") {
    const minSources = Math.max(1, opts.minSources || 4);
    lines.push("Use the web_search tool to verify factual claims before answering.");
    lines.push(`Ground the answer in at least ${minSources} distinct retrieved sources when available.`);
    lines.push("Do not emit inline citation markers; the runtime renders sources separately.");
    lines.push("Do not print raw URLs in the answer body.");
    lines.push("Only cite URLs returned by web_search; never invent links.");
    lines.push("If reliable sources are unavailable, say so in one short sentence.");
    lines.push("Do not add a Sources/References section; the UI renders it.");
    lines.push("If you end with a short tailoring follow-up, stop immediately after that block.");
    if (opts.enforceMinSources) {
      lines.push("If you cannot meet the source requirement, answer briefly and note missing sources.");
    }
  } else if (strategy === "CREATIVE_NARRATIVE") {
    lines.push("Write creatively with natural flow.");
    lines.push("Avoid forced bullets or headings unless asked.");
  }
  return lines.join("\n");
}

function buildSectionPlan(
  titles: string[],
  allowedTypes: ChatResponseSegment["type"][] = ["paragraph", "list", "table", "code", "header"],
): ResponsePlan["sectionPlan"] {
  return titles.slice(0, 6).map((title, index) => ({
    id: `section-${index + 1}`,
    title,
    allowedTypes,
  }));
}

export function buildStructuredResponsePlan(params: {
  message: string;
  classification: UaoClassification;
  selection: UaoStrategySelection;
  signals?: RequestSignals;
}): ResponsePlan {
  const signals = params.signals || extractRequestSignals(params.message);
  const strategy: ResponsePlanStrategy = signals.wantsComparison
    ? "comparison"
    : signals.wantsHowTo
      ? "howto"
      : params.selection.strategy === "INSTANT_ANSWER"
        ? "brief"
        : "analysis";

  const sectionTitles = (() => {
    if (strategy === "brief") return ["Answer", "Key Points"];
    if (strategy === "comparison") return ["Overview", "Comparison", "Recommendation"];
    if (strategy === "howto") return ["Overview", "Steps", "Checks"];
    if (params.classification.intent === "DEBUG_DIAGNOSIS") {
      return ["Diagnosis", "Root Cause", "Fix"];
    }
    return ["Direct Answer", "Key Details", "Evidence"];
  })();

  return {
    strategy,
    maxSections: 6,
    maxSegments: 12,
    maxTableRows: 12,
    maxListItems: 7,
    maxParagraphChars: 700,
    maxCodeLines: 80,
    maxCodeChars: 4000,
    sectionPlan: buildSectionPlan(sectionTitles),
    stopMode: "schema_complete",
  };
}

function estimateMaxTokens(strategy: UaoStrategy, complexity: UaoComplexity): number {
  if (strategy === "INSTANT_ANSWER") return 120;
  if (strategy === "CREATIVE_NARRATIVE") {
    if (complexity === "TRIVIAL") return 260;
    if (complexity === "MODERATE") return 500;
    return 900;
  }
  if (complexity === "TRIVIAL") return 220;
  if (complexity === "MODERATE") return 700;
  if (complexity === "HIGH") return 1400;
  return 2200;
}

function estimateTemperature(strategy: UaoStrategy): number | undefined {
  if (strategy === "CREATIVE_NARRATIVE") return 0.9;
  if (strategy === "INSTANT_ANSWER") return 0.2;
  if (strategy === "DEEP_REASONING") return 0.2;
  if (strategy === "RETRIEVAL_AUGMENTED") return 0.2;
  return 0.35;
}

function extractOutputText(payload: any): string {
  if (!payload) return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (Array.isArray(payload.output_text)) {
    const joined = payload.output_text.filter(Boolean).join("\n");
    if (joined.trim()) return joined;
  }
  if (typeof payload.response?.output_text === "string" && payload.response.output_text.trim()) {
    return payload.response.output_text;
  }
  if (Array.isArray(payload.response?.output_text)) {
    const joined = payload.response.output_text.filter(Boolean).join("\n");
    if (joined.trim()) return joined;
  }
  if (Array.isArray(payload.output)) {
    const text = payload.output
      .map((item: any) =>
        Array.isArray(item?.content)
          ? item.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("")
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }
  if (Array.isArray(payload.response?.output)) {
    const text = payload.response.output
      .map((item: any) =>
        Array.isArray(item?.content)
          ? item.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("")
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }
  return "";
}

function stripInlineCitationMarkers(text: string): string {
  if (!text) return "";
  return text
    .replace(/(\w)[ \t]*\[(\d+)\][ \t]*(\w)/g, "$1 $3")
    .replace(/[ \t]*\[(\d+)\]/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

function fixUnclosedCodeFence(text: string): { text: string; fixed: boolean } {
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 0) return { text, fixed: false };
  return { text: `${text}\n\`\`\``, fixed: true };
}

function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n" && index + 1 < text.length) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function matchesUserInputRequiredLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return USER_INPUT_REQUIRED_STOP_PATTERNS.some(pattern => pattern.test(trimmed));
}

function looksLikeNewSection(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  if (/^---+$/.test(trimmed)) return true;
  if (/^\d+[.)]\s+/.test(trimmed)) return true;
  if (/^[A-Z][A-Za-z0-9 ()./'-]{1,80}:?$/.test(trimmed) && trimmed.split(/\s+/).length <= 12) return true;
  return false;
}

export function findUserInputRequiredBoundary(text: string): number | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const offsets = buildLineOffsets(text);
  for (let index = 0; index < lines.length; index += 1) {
    if (!matchesUserInputRequiredLine(lines[index] || "")) continue;
    let sawTailContent = false;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const trimmed = (lines[nextIndex] || "").trim();
      if (trimmed) sawTailContent = true;
      if (sawTailContent && looksLikeNewSection(trimmed) && !matchesUserInputRequiredLine(trimmed)) {
        return offsets[nextIndex] ?? text.length;
      }
    }
    return text.length;
  }
  return null;
}

function normalizeSourceUrlKey(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return value.trim();
  }
}

function splitTrailingUrlPunctuation(rawUrl: string): { url: string; trailing: string } {
  const trimmed = rawUrl.replace(/[),.;:!?]+$/g, "");
  return {
    url: trimmed || rawUrl,
    trailing: rawUrl.slice((trimmed || rawUrl).length),
  };
}

function mergeAdjacentTextSegments(segments: AnswerSegment[]): AnswerSegment[] {
  const merged: AnswerSegment[] = [];
  (segments || []).forEach((segment) => {
    if (!segment) return;
    const last = merged[merged.length - 1];
    if (segment.type === "text" && last?.type === "text") {
      last.text += segment.text;
      return;
    }
    merged.push(segment);
  });
  return merged;
}

function buildTextFromSegments(segments: AnswerSegment[]): string {
  return (segments || [])
    .map(segment => (segment.type === "text" ? segment.text : ""))
    .join("")
    .trim();
}

function flattenSegmentsForAudit(
  segments: AnswerSegment[],
  opts: { hasSources: boolean },
): { text: string; citations: Array<Extract<AnswerSegment, { type: "citation" }>>; issues: string[] } {
  const citations: Array<Extract<AnswerSegment, { type: "citation" }>> = [];
  const parts: string[] = [];
  const issues = new Set<string>();

  (segments || []).forEach((segment) => {
    if (!segment) return;
    if (segment.type === "citation") {
      if (!opts.hasSources) {
        issues.add("stripped_citations_without_sources");
        return;
      }
      citations.push(segment);
      parts.push(`${AUDIT_CITATION_TOKEN_PREFIX}${citations.length - 1}${AUDIT_CITATION_TOKEN_SUFFIX}`);
      return;
    }
    parts.push(typeof segment.text === "string" ? segment.text : "");
  });

  return { text: parts.join(""), citations, issues: Array.from(issues) };
}

function rebuildSegmentsFromAuditText(
  text: string,
  citations: Array<Extract<AnswerSegment, { type: "citation" }>>,
): AnswerSegment[] {
  const rebuilt: AnswerSegment[] = [];
  let cursor = 0;

  text.replace(AUDIT_CITATION_TOKEN_RE, (match, rawIndex, offset) => {
    const start = Number(offset);
    const index = Number(rawIndex);
    if (start > cursor) {
      rebuilt.push({ type: "text", text: text.slice(cursor, start) });
    }
    const citation = citations[index];
    if (citation) {
      rebuilt.push({ ...citation });
    } else {
      rebuilt.push({ type: "text", text: match });
    }
    cursor = start + match.length;
    return match;
  });

  if (cursor < text.length) {
    rebuilt.push({ type: "text", text: text.slice(cursor) });
  }

  return mergeAdjacentTextSegments(rebuilt);
}

function convertVerifiedInlineUrls(
  segments: AnswerSegment[],
  sources: CitationSource[],
): { segments: AnswerSegment[]; issues: string[] } {
  const issues = new Set<string>();
  const sourceByKey = new Map(sources.map(source => [normalizeSourceUrlKey(source.url), source] as const));
  const converted: AnswerSegment[] = [];

  (segments || []).forEach((segment) => {
    if (!segment) return;
    if (segment.type !== "text") {
      converted.push(segment);
      return;
    }

    const text = typeof segment.text === "string" ? segment.text : "";
    if (!text) return;
    let cursor = 0;

    for (const match of text.matchAll(RAW_URL_RE)) {
      const rawUrl = match[0];
      const start = match.index ?? -1;
      if (start < 0) continue;
      const end = start + rawUrl.length;
      if (start > cursor) {
        converted.push({ type: "text", text: text.slice(cursor, start) });
      }
      const normalized = splitTrailingUrlPunctuation(rawUrl);
      const source = sourceByKey.get(normalizeSourceUrlKey(normalized.url));
      if (source) {
        converted.push({ type: "citation", id: source.id, url: source.url, title: source.title });
        issues.add("lifted_verified_inline_url");
      } else {
        issues.add("stripped_unverified_inline_url");
      }
      if (normalized.trailing) {
        converted.push({ type: "text", text: normalized.trailing });
      }
      cursor = end;
    }

    if (cursor < text.length) {
      converted.push({ type: "text", text: text.slice(cursor) });
    }
  });

  return { segments: mergeAdjacentTextSegments(converted), issues: Array.from(issues) };
}

function sanitizeOutputText(text: string, opts: { hasSources: boolean }): { text: string; issues: string[] } {
  let next = text || "";
  const issues: string[] = [];
  const lines = next.split(/\r?\n/);
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed === "O.W.E.N. Is Thinking" || trimmed === "Thinking") {
      issues.push("internal_placeholder");
      return false;
    }
    if (/^:::citations\b/i.test(trimmed)) {
      issues.push("citation_block");
      return false;
    }
    if (/^\s*\{.*\"tool\"/i.test(trimmed) || /^\s*\{.*\"function\"/i.test(trimmed)) {
      issues.push("tool_json");
      return false;
    }
    return true;
  });
  next = filtered.join("\n").trim();
  const strippedSources = stripTrailingSourcesSection(next);
  if (strippedSources !== next) {
    issues.push("stripped_rendered_sources_section");
    next = strippedSources;
  }
  if (!opts.hasSources && /\[\d+\]/.test(next)) {
    issues.push("stripped_citations_without_sources");
    next = stripInlineCitationMarkers(next);
  }
  const fence = fixUnclosedCodeFence(next);
  if (fence.fixed) {
    issues.push("closed_code_fence");
    next = fence.text;
  }
  return { text: next.trim(), issues };
}

export function applyDeterministicAudit(
  answerText: string,
  answerSegments: AnswerSegment[],
  sources: CitationSource[],
): {
  answerText: string;
  answerSegments: AnswerSegment[];
  sources: CitationSource[];
  issues: string[];
  stopReason?: typeof USER_INPUT_REQUIRED_STOP_REASON;
} {
  const hasSources = sources.length > 0;
  const baseSegments = answerSegments.length ? answerSegments : buildAnswerSegments(answerText);
  const flattened = flattenSegmentsForAudit(baseSegments, { hasSources });
  const issues = new Set<string>(flattened.issues);
  const audit = sanitizeOutputText(flattened.text || answerText, { hasSources });
  audit.issues.forEach(issue => issues.add(issue));
  let nextTextWithTokens = audit.text;
  let stopReason: typeof USER_INPUT_REQUIRED_STOP_REASON | undefined;

  const userInputBoundary = findUserInputRequiredBoundary(nextTextWithTokens);
  if (userInputBoundary !== null) {
    stopReason = USER_INPUT_REQUIRED_STOP_REASON;
    if (userInputBoundary < nextTextWithTokens.length) {
      nextTextWithTokens = nextTextWithTokens.slice(0, userInputBoundary).trim();
      issues.add("trimmed_after_user_input_required");
    }
  }

  let nextSegments = rebuildSegmentsFromAuditText(nextTextWithTokens, flattened.citations);
  if (!nextSegments.length && nextTextWithTokens.trim()) {
    nextSegments = buildAnswerSegments(nextTextWithTokens);
  }

  const convertedUrls = convertVerifiedInlineUrls(nextSegments, sources);
  nextSegments = convertedUrls.segments;
  convertedUrls.issues.forEach(issue => issues.add(issue));
  let nextText = buildTextFromSegments(nextSegments);

  if (!nextText.trim()) {
    nextText = "(empty response)";
    nextSegments = buildAnswerSegments(nextText);
    issues.add("empty_response_fallback");
  }

  return {
    answerText: nextText,
    answerSegments: nextSegments,
    sources,
    issues: Array.from(issues),
    stopReason,
  };
}

export function buildRenderHints(
  text: string,
  sources: CitationSource[],
  opts: {
    longAnswerChars: number;
    typewriterSpeedMs?: number;
    format?: "markdown_safe";
    stopReason?: typeof USER_INPUT_REQUIRED_STOP_REASON;
  },
): RenderHints {
  const length = (text || "").trim().length;
  return {
    renderMode: length > opts.longAnswerChars ? "typewriter" : "instant",
    showSources: sources.length > 0,
    typewriterSpeedMs: opts.typewriterSpeedMs,
    format: opts.format,
    stopReason: opts.stopReason,
  };
}

async function maybeClassifyWithLlm(
  input: OrchestrateInput,
  deps: OrchestrateDeps,
): Promise<UaoClassification | null> {
  const model = input.modelCandidates[0] || DEFAULT_TEXT_MODEL;
  const prompt = [
    "Classify the user request into intent, complexity, and volatility.",
    "Return strict JSON only with keys: intent, complexity, volatility, confidence.",
    "Allowed intents: FACT_LOOKUP, CONCEPT_EXPLANATION, COMPARISON, STEP_BY_STEP_REASONING, CREATIVE_NARRATIVE, OPINION_ANALYSIS, PROCEDURAL_HOWTO, MATH_FORMAL, DEBUG_DIAGNOSIS.",
    "Allowed complexity: TRIVIAL, MODERATE, HIGH, EXPERT.",
    "Allowed volatility: STABLE, SEMI_STABLE, VOLATILE.",
    `User: ${input.message}`,
  ].join("\n");
  const payload: Record<string, unknown> = {
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    max_output_tokens: 120,
    temperature: 0,
  };
  const response = await deps.callResponsesJson(payload, "uao-classifier");
  const raw = extractOutputText(response);
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const intent = typeof parsed.intent === "string" ? parsed.intent.toUpperCase() : "";
  const complexity = typeof parsed.complexity === "string" ? parsed.complexity.toUpperCase() : "";
  const volatility = typeof parsed.volatility === "string" ? parsed.volatility.toUpperCase() : "";
  const confidence = Number(parsed.confidence);
  if (!intent || !complexity || !volatility || !Number.isFinite(confidence)) return null;
  return {
    intent: intent as UaoIntent,
    complexity: complexity as UaoComplexity,
    volatility: volatility as UaoVolatility,
    confidence: clamp(confidence, 0, 1),
    signals: ["llm_classifier"],
  };
}

async function maybeRunQc(
  text: string,
  input: OrchestrateInput,
  deps: OrchestrateDeps,
  strategy: UaoStrategy,
): Promise<{ pass: boolean; issues: string[]; fixInstruction: string } | null> {
  const model = input.modelCandidates[0] || DEFAULT_TEXT_MODEL;
  const prompt = [
    "You are a strict QA checker. Return JSON only.",
    "Schema: {\"pass\": boolean, \"issues\": string[], \"fix_instruction\": string}",
    `Strategy: ${strategy}`,
    "Check for: direct answer, matches complexity, no filler, no internal labels, no missing context.",
    `Answer: ${text}`,
  ].join("\n");
  const payload: Record<string, unknown> = {
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    max_output_tokens: 180,
    temperature: 0,
  };
  const response = await deps.callResponsesJson(payload, "uao-qc");
  const raw = extractOutputText(response);
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const pass = Boolean(parsed.pass);
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(Boolean).map(String) : [];
  const fixInstruction = typeof parsed.fix_instruction === "string" ? parsed.fix_instruction : "";
  return { pass, issues, fixInstruction };
}

function safeJsonParse(raw: string): any | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function shouldTriggerQc(
  text: string,
  classification: UaoClassification,
  strategy: UaoStrategy,
  input: OrchestrateInput,
): boolean {
  if (!input.flags?.llmQcEnabled) return false;
  if (findUserInputRequiredBoundary(text) !== null) return false;
  if (classification.complexity === "HIGH" || classification.complexity === "EXPERT") return true;
  const length = text.trim().length;
  if (strategy === "INSTANT_ANSWER") {
    return length > 260;
  }
  if (strategy === "STRUCTURED_EXPLANATION") {
    return length < 120 || length > 1800;
  }
  if (strategy === "DEEP_REASONING") {
    return length < 180 || length > 2400;
  }
  if (strategy === "CREATIVE_NARRATIVE") {
    return length < 120 || length > 1600;
  }
  return false;
}

function buildAnswerSegments(text: string): AnswerSegment[] {
  const trimmed = (text || "").trim();
  return trimmed ? [{ type: "text", text: trimmed }] : [];
}

async function callWithFallback(
  modelCandidates: string[],
  buildPayload: (model: string) => Record<string, unknown>,
  deps: OrchestrateDeps,
  label: string,
): Promise<any> {
  const selected = modelCandidates[0] || DEFAULT_TEXT_MODEL;
  return deps.callResponsesJson(buildPayload(selected), label);
}

export async function orchestrate(input: OrchestrateInput, deps: OrchestrateDeps): Promise<OrchestrateResult> {
  const started = Date.now();
  const timings: UaoDebugMeta["timings"] = {};
  const classifyStart = Date.now();
  const signals = extractRequestSignals(input.message);
  let classification = classifyHeuristic(input.message);
  timings.classifyMs = Date.now() - classifyStart;
  let usedLlmClassifier = false;

  const classifierThreshold = input.thresholds?.classifierConfidence ?? DEFAULT_CLASSIFIER_CONFIDENCE;
  if (input.flags?.llmClassifierEnabled && classification.confidence < classifierThreshold) {
    const llmClassification = await maybeClassifyWithLlm(input, deps);
    if (llmClassification) {
      classification = llmClassification;
      usedLlmClassifier = true;
    }
  }

  const strategyStart = Date.now();
  const selection = input.strategyOverrides?.forceStrategy
    ? { strategy: input.strategyOverrides.forceStrategy, reason: ["forced"] }
    : selectStrategy(classification, signals, {
      webSearchAvailable: input.tools.webSearchAvailable,
      forceThinking: input.responseMode === "thinking",
    });
  timings.strategyMs = Date.now() - strategyStart;

  const debugMeta: UaoDebugMeta = {
    classification,
    strategy: selection,
    usedLlmClassifier,
    retrievalUsed: selection.strategy === "RETRIEVAL_AUGMENTED",
    timings,
  };

  deps.logger?.("uao.classify", {
    intent: classification.intent,
    complexity: classification.complexity,
    volatility: classification.volatility,
    confidence: classification.confidence,
    strategy: selection.strategy,
    usedLlmClassifier,
  });

  const instructions = buildStrategyInstructions(selection.strategy, classification, signals, {
    minSources: input.minSources,
    enforceMinSources: input.enforceMinSources,
    userSettings: input.userSettings,
  });

  let answerText = "";
  let answerSegments: AnswerSegment[] = [];
  let sources: CitationSource[] = [];
  let consultedSources: unknown[] | undefined;
  let warnings: OrchestrateResult["warnings"];
  const generateStart = Date.now();

  if (selection.strategy === "RETRIEVAL_AUGMENTED") {
    if (deps.runRetrieval) {
      const retrieval = await deps.runRetrieval({ instructions });
      answerSegments = retrieval.answerSegments;
      sources = retrieval.sources;
      consultedSources = retrieval.consultedSources;
      warnings = retrieval.warnings;
      answerText = answerSegments.map(seg => (seg.type === "text" ? seg.text : "")).join("").trim();
    } else {
      const response = await callWithFallback(
        input.modelCandidates,
        (model) => ({
          model,
          input: input.responseInputs,
          instructions,
          ...buildResponsesToolConfig(input.tools.webSearchAvailable ? ["web_search"] : [], "auto"),
          max_output_tokens: estimateMaxTokens(selection.strategy, classification.complexity),
          temperature: estimateTemperature(selection.strategy),
        }),
        deps,
        "uao-retrieval",
      );
      const cited = deps.buildCitedAnswerPayload(response);
      answerSegments = cited.answerSegments;
      sources = cited.sources;
      consultedSources = cited.consultedSources;
      answerText = cited.answerText;
    }
  } else {
    const response = await callWithFallback(
      input.modelCandidates,
      (model) => ({
        model,
        input: input.responseInputs,
        instructions,
        max_output_tokens: estimateMaxTokens(selection.strategy, classification.complexity),
        temperature: estimateTemperature(selection.strategy),
      }),
      deps,
      `uao-${selection.strategy.toLowerCase()}`,
    );
    answerText = extractOutputText(response).trim();
    answerSegments = buildAnswerSegments(answerText);
  }
  timings.generateMs = Date.now() - generateStart;

  const audited = applyDeterministicAudit(answerText, answerSegments, sources);
  answerText = audited.answerText;
  answerSegments = audited.answerSegments;
  sources = audited.sources;
  if (audited.issues.length) {
    debugMeta.qc = {
      enabled: Boolean(input.flags?.llmQcEnabled),
      pass: true,
      issues: audited.issues,
    };
  }

  const qcStart = Date.now();
  if (shouldTriggerQc(answerText, classification, selection.strategy, input)) {
    const qc = await maybeRunQc(answerText, input, deps, selection.strategy);
    if (qc) {
      debugMeta.qc = {
        enabled: true,
        pass: qc.pass,
        retryUsed: false,
        issues: qc.issues,
      };
      if (!qc.pass && qc.fixInstruction) {
        if (selection.strategy === "RETRIEVAL_AUGMENTED") {
          if (deps.runRetrieval) {
            const retrieval = await deps.runRetrieval({
              instructions: `${instructions}\n\nFixes required: ${qc.fixInstruction}`,
            });
            answerSegments = retrieval.answerSegments;
            sources = retrieval.sources;
            consultedSources = retrieval.consultedSources ?? consultedSources;
            warnings = retrieval.warnings ?? warnings;
            answerText = answerSegments.map(seg => (seg.type === "text" ? seg.text : "")).join("").trim();
          } else {
            const response = await callWithFallback(
              input.modelCandidates,
              (model) => ({
                model,
                input: input.responseInputs,
                instructions: `${instructions}\n\nFixes required: ${qc.fixInstruction}`,
                ...buildResponsesToolConfig(input.tools.webSearchAvailable ? ["web_search"] : [], "auto"),
                max_output_tokens: estimateMaxTokens(selection.strategy, classification.complexity),
                temperature: estimateTemperature(selection.strategy),
              }),
              deps,
              "uao-qc-retry-retrieval",
            );
            const cited = deps.buildCitedAnswerPayload(response);
            answerSegments = cited.answerSegments;
            sources = cited.sources;
            consultedSources = cited.consultedSources ?? consultedSources;
            answerText = cited.answerText;
          }
        } else {
          const payload: Record<string, unknown> = {
            model: input.modelCandidates[0] || DEFAULT_TEXT_MODEL,
            input: input.responseInputs,
            instructions: `${instructions}\n\nFixes required: ${qc.fixInstruction}`,
            max_output_tokens: estimateMaxTokens(selection.strategy, classification.complexity),
            temperature: estimateTemperature(selection.strategy),
          };
          const response = await deps.callResponsesJson(payload, "uao-qc-retry");
          answerText = extractOutputText(response).trim();
          answerSegments = buildAnswerSegments(answerText);
        }
        const reaudited = applyDeterministicAudit(answerText, answerSegments, sources);
        answerText = reaudited.answerText;
        answerSegments = reaudited.answerSegments;
        sources = reaudited.sources;
        if (reaudited.issues.length) {
          const existingIssues = Array.isArray(debugMeta.qc.issues) ? debugMeta.qc.issues : [];
          debugMeta.qc.issues = Array.from(new Set([...existingIssues, ...reaudited.issues]));
        }
        debugMeta.qc.retryUsed = true;
      }
    }
  }
  timings.qcMs = Date.now() - qcStart;
  timings.totalMs = Date.now() - started;

  const renderHints = buildRenderHints(answerText, sources, {
    longAnswerChars: input.thresholds?.longAnswerChars ?? DEFAULT_LONG_ANSWER_CHARS,
    typewriterSpeedMs: input.typewriterSpeedMs,
    stopReason: audited.stopReason,
  });

  deps.logger?.("uao.result", {
    strategy: selection.strategy,
    answerChars: answerText.length,
    sourcesCount: sources.length,
    renderMode: renderHints.renderMode,
    timings,
  });

  return {
    answerText,
    answerSegments,
    sources,
    consultedSources,
    warnings,
    renderHints,
    debugMeta,
  };
}
