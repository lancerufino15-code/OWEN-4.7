import { GENERATED_PROMPT_REGISTRY, type GeneratedPromptRegistryEntry } from "../generated/prompt-registry";

export type PromptDomain = GeneratedPromptRegistryEntry["domain"];
export type PromptFormat = GeneratedPromptRegistryEntry["format"];

export type PromptRegistryEntry = {
  id: string;
  domain: PromptDomain;
  version: string;
  sourceFile: string;
  modelHint?: string;
  maxOutputTokensHint?: number;
  variables: Record<string, string>;
  format: PromptFormat;
  sizeBytes: number;
  text: string;
};

type LectureQuizPromptOpts = {
  lectureId: string;
  lectureTitle?: string;
  context: string;
  referenceLabels?: string[];
  excludeQuestions?: string[];
  count?: number;
};

type GeminiQuizPromptOpts = {
  lectureId: string;
  lectureTitle?: string;
  lectureContext: string;
  priorQuestions?: string[];
  referenceLabels?: string[];
  questionCount?: number;
};

const PROMPT_REGISTRY: PromptRegistryEntry[] = GENERATED_PROMPT_REGISTRY.map((entry) => ({
  ...entry,
  modelHint: "modelHint" in entry ? entry.modelHint : undefined,
  maxOutputTokensHint: "maxOutputTokensHint" in entry ? entry.maxOutputTokensHint : undefined,
  variables: { ...entry.variables },
}));

function getPromptSections(id: string): { system: string; user: string } {
  const entry = getPromptEntry(id);
  if (entry.format !== "system_user") {
    throw new Error(`Prompt ${id} is not a system/user prompt.`);
  }
  const marker = "<<<USER>>>\n";
  const systemPrefix = "<<<SYSTEM>>>\n";
  if (!entry.text.startsWith(systemPrefix) || !entry.text.includes(marker)) {
    throw new Error(`Prompt ${id} is missing system/user markers.`);
  }
  const systemText = entry.text.slice(systemPrefix.length, entry.text.indexOf(marker));
  const userText = entry.text.slice(entry.text.indexOf(marker) + marker.length);
  return {
    system: systemText.trim(),
    user: userText.trim(),
  };
}

function resolveQuizCount(countInput: number | undefined, fallback: number): number {
  const count = typeof countInput === "number" && Number.isFinite(countInput) ? Math.floor(countInput) : 0;
  return count > 0 ? count : fallback;
}

function buildQuizReferenceList(labelsInput?: string[]): string {
  const labels = (labelsInput || []).map((label) => label.trim()).filter(Boolean);
  return labels.length ? labels.map((label) => `- ${label}`).join("\n") : "- (none)";
}

function buildQuizExcludeSection(excludeInput?: string[]): string[] {
  const excludeList = (excludeInput || []).map((item) => item.trim()).filter(Boolean);
  if (!excludeList.length) return [];
  return [
    "Previously asked questions (DO NOT repeat or paraphrase):",
    ...excludeList.map((item) => `- ${item}`),
    "",
  ];
}

export function getPromptRegistry(): PromptRegistryEntry[] {
  return PROMPT_REGISTRY;
}

export function getPromptEntry(id: string): PromptRegistryEntry {
  const match = PROMPT_REGISTRY.find((entry) => entry.id === id);
  if (!match) throw new Error(`Unknown prompt id: ${id}`);
  return match;
}

export function getPromptText(id: string): string {
  return getPromptEntry(id).text;
}

export function buildLectureQuizPrompt(opts: LectureQuizPromptOpts): { system: string; user: string } {
  const base = getPromptSections("quiz.lecture.hidden-pipeline");
  const referenceList = buildQuizReferenceList(opts.referenceLabels);
  const lectureTitle = (opts.lectureTitle || "").trim();
  const count = resolveQuizCount(opts.count, 5);
  const excludeSection = buildQuizExcludeSection(opts.excludeQuestions);

  return {
    system: base.system,
    user: [
      "Task: Generate a board-style lecture quiz from the excerpts below.",
      "Use only provided lecture facts (no outside medical facts).",
      `Generate exactly ${count} questions.`,
      "Run all hidden stages and internal validator in one completion.",
      "Return strict JSON matching the required top-level contract.",
      "",
      `Lecture ID: ${opts.lectureId}`,
      lectureTitle ? `Lecture Title: ${lectureTitle}` : "",
      "Reference labels:",
      referenceList,
      "",
      ...excludeSection,
      "Lecture excerpts:",
      opts.context || "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function buildGeminiQuizPrompt(opts: GeminiQuizPromptOpts): { system: string; user: string } {
  const base = getPromptSections("quiz.gemini");
  const lectureTitle = String(opts.lectureTitle || "").trim();
  const questionCount = resolveQuizCount(opts.questionCount, 5);
  const priorQuestions = Array.isArray(opts.priorQuestions)
    ? opts.priorQuestions.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
    : [];
  const referenceLabels = Array.isArray(opts.referenceLabels)
    ? opts.referenceLabels.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
    : [];

  return {
    system: base.system
      .replace(/Return exactly 5 questions\./, `Return exactly ${questionCount} questions.`)
      .replace(/  "setSize": 5,/, `  "setSize": ${questionCount},`)
      .replace(/lectureId must equal "\{\{LECTURE_ID\}\}"/, `lectureId must equal "${opts.lectureId}"`)
      .replace(/lectureTitle must equal "\{\{LECTURE_TITLE\}\}"/, lectureTitle ? `lectureTitle must equal "${lectureTitle}"` : "lectureTitle must be a non-empty string.")
      .replace(/setSize must equal 5\./, `setSize must equal ${questionCount}.`),
    user: [
      `Lecture ID: ${opts.lectureId}`,
      lectureTitle ? `Lecture Title: ${lectureTitle}` : "",
      referenceLabels.length ? `Available reference labels: ${referenceLabels.join(" | ")}` : "",
      priorQuestions.length
        ? [
          "Avoid repeating or lightly paraphrasing these prior question stems:",
          ...priorQuestions.map((item, index) => `${index + 1}. ${item}`),
        ].join("\n")
        : "",
      "Lecture text:",
      opts.lectureContext || "",
      `Based only on the lecture text above, generate exactly ${questionCount} board-style questions that satisfy the policy and return only the required JSON object.`,
    ].filter(Boolean).join("\n\n"),
  };
}

export const ANKI_PROMPT_TEMPLATE = getPromptText("anki.generate");
export const STUDY_GUIDE_CANONICAL_PROMPT = getPromptText("study-guide.canonical-html");
export const STUDY_GUIDE_MAXIMAL_FACT_REWRITE_PROMPT = getPromptText("study-guide.maximal.fact-rewrite");
export const STUDY_GUIDE_MAXIMAL_HTML_PROMPT = getPromptText("study-guide.maximal.html");
export const STUDY_GUIDE_STEP_A_EXTRACT_PROMPT = getPromptText("study-guide.step-a.extract");
export const STUDY_GUIDE_STEP_A_DERIVE_PROMPT = getPromptText("study-guide.step-a.derive");
export const STUDY_GUIDE_STEP_A2_SYNTHESIS_PROMPT = getPromptText("study-guide.step-a2.synthesis");
export const STUDY_GUIDE_STEP_B_ENHANCED_PROMPT = getPromptText("study-guide.step-b.enhanced");
export const STUDY_GUIDE_STEP_B_PLAN_PROMPT = getPromptText("study-guide.step-b.plan");
export const STUDY_GUIDE_STEP_B1_OUTLINE_PROMPT = getPromptText("study-guide.step-b.outline");
export const STUDY_GUIDE_STEP_B2_PACK_JSON_PROMPT = getPromptText("study-guide.step-b.pack-json");
export const STUDY_GUIDE_STEP_B2_REWRITE_JSON_PROMPT = getPromptText("study-guide.step-b.rewrite-json");
export const STUDY_GUIDE_STEP_B_DRAFT_PROMPT = getPromptText("study-guide.step-b.draft");
export const STUDY_GUIDE_STEP_B_QC_REWRITE_PROMPT = getPromptText("study-guide.step-b.qc-rewrite");
export const STUDY_GUIDE_STEP_B_SYNTHESIS_REWRITE_PROMPT = getPromptText("study-guide.step-b.synthesis-rewrite");
export const STUDY_GUIDE_STEP_C_QA_PROMPT = getPromptText("study-guide.step-c.qa");
