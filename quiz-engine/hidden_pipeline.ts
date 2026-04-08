/**
 * Hidden quiz pipeline envelope helpers.
 *
 * Used by: `src/index.ts` quiz generation.
 */

type QuizChoiceLike = { id?: unknown; text?: unknown };
type QuizQuestionLike = {
  id?: unknown;
  stem?: unknown;
  choices?: unknown;
  options?: unknown;
  answer?: unknown;
  rationale?: unknown;
  explanation?: unknown;
  tags?: unknown;
  difficulty?: unknown;
  references?: unknown;
};
type QuizBatchLike = {
  lectureId?: unknown;
  lectureTitle?: unknown;
  setSize?: unknown;
  mode?: unknown;
  questions?: unknown;
};

export type QuizPipelineInspection = {
  source: "legacy" | "pipeline";
  batchCandidate: unknown;
  internalErrors: string[];
  debugFlag: boolean;
  reportedFailedChecks: string[];
};

export type QuizBatchCoercionContext = {
  lectureId: string;
  lectureTitle: string;
  expectedCount: number;
};

const QUIZ_CHOICE_IDS = ["A", "B", "C", "D", "E"] as const;
const QUIZ_DIFFICULTY_SET = new Set(["easy", "medium", "hard"]);
const OVERRIDE_HINTS = [
  "despite",
  "although",
  "however",
  "override",
  "overrides",
  "overriding",
  "conflict",
  "even though",
  "but",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  const text = asString(value).toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "y";
}

function asInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.floor(value);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function gatherStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => asString(item))
    .filter(Boolean);
}

function gatherStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const single = asString(value);
    return single ? [single] : [];
  }
  return gatherStringArray(value);
}

function gatherChecksFromItem(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const validator = value.validator;
  if (!isPlainObject(validator)) return [];
  return gatherStringArray(validator.failed_checks);
}

function getDifferentialTarget(differentialSet: Record<string, unknown>): string {
  return asString(differentialSet.target) || asString(differentialSet.target_diagnosis);
}

function normalizeQuestionChoices(question: QuizQuestionLike): QuizChoiceLike[] {
  const direct = Array.isArray(question.choices) ? question.choices : [];
  if (direct.length) return direct.filter(isPlainObject) as QuizChoiceLike[];
  const options = question.options;
  if (!isPlainObject(options)) return [];
  return QUIZ_CHOICE_IDS.map(id => ({ id, text: asString(options[id]) }));
}

function toChoiceOutput(choice: QuizChoiceLike): { id: string; text: string } | null {
  const idRaw = asString(choice.id).toUpperCase();
  if (!QUIZ_CHOICE_IDS.includes(idRaw as (typeof QUIZ_CHOICE_IDS)[number])) return null;
  const text = asString(choice.text);
  if (!text) return null;
  return { id: idRaw, text };
}

function normalizeQuestionToLegacy(question: QuizQuestionLike, index: number): Record<string, unknown> {
  const choicesRaw = normalizeQuestionChoices(question);
  const choices = choicesRaw.map(toChoiceOutput).filter((choice): choice is { id: string; text: string } => Boolean(choice));

  const id = asString(question.id) || `q${index + 1}`;
  const answer = asString(question.answer).toUpperCase();
  const rationale = asString(question.rationale) || asString(question.explanation);
  const tags = gatherStringArray(question.tags).slice(0, 3);
  const difficultyRaw = asString(question.difficulty).toLowerCase();
  const difficulty = QUIZ_DIFFICULTY_SET.has(difficultyRaw) ? difficultyRaw : "hard";
  const references = gatherStringArray(question.references).slice(0, 2);

  return {
    id,
    stem: asString(question.stem),
    choices,
    answer,
    rationale,
    tags: tags.length ? tags : ["board-style"],
    difficulty,
    references,
  };
}

function isLegacyBatchShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const questions = Array.isArray(value.questions) ? value.questions : [];
  if (!questions.length) return false;
  const first = questions[0];
  if (!isPlainObject(first)) return false;
  return Array.isArray(first.choices);
}

function isStage3QuizShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const mode = asString(value.mode).toLowerCase();
  const questions = Array.isArray(value.questions) ? value.questions : [];
  if (!questions.length) return false;
  if (mode === "quiz") return true;
  const first = questions[0];
  if (!isPlainObject(first)) return false;
  return isPlainObject(first.options) || typeof first.explanation === "string";
}

function stemIncludesEvidence(stem: string, evidence: string): boolean {
  const cleanEvidence = normalizeText(evidence);
  if (!cleanEvidence) return false;
  const cleanStem = normalizeText(stem);
  return cleanStem.includes(cleanEvidence);
}

function rationaleMentionsLabel(rationale: string, label: string): boolean {
  if (!label) return false;
  const regex = new RegExp(`(?:^|\\n|\\r|\\s)${label}\\s*[:)\\.-]`, "i");
  if (regex.test(rationale)) return true;
  return rationale.toLowerCase().includes(`option ${label.toLowerCase()}`);
}

function getQuestionByIdOrIndex(questions: QuizQuestionLike[], items: Record<string, unknown>[], index: number): Record<string, unknown> | undefined {
  const question = questions[index];
  const qid = asString(question?.id);
  if (qid) {
    const byId = items.find(item => asString(item.question_id) === qid);
    if (byId) return byId;
  }
  return items[index];
}

function choiceShapeScore(text: string): string {
  return [
    /\d/.test(text) ? "num" : "nonum",
    /[()]/.test(text) ? "paren" : "noparen",
    /[,;]/.test(text) ? "punct" : "nopunct",
    /\b(and|or)\b/i.test(text) ? "compound" : "simple",
  ].join(":");
}

function looksHomogeneous(choices: QuizChoiceLike[]): boolean {
  if (choices.length < 2) return false;
  const texts = choices.map(choice => asString(choice.text)).filter(Boolean);
  if (texts.length !== choices.length) return false;
  const counts = texts.map(text => text.split(/\s+/).filter(Boolean).length);
  const minWords = Math.min(...counts);
  const maxWords = Math.max(...counts);
  if (maxWords - minWords > 4) return false;
  const shapes = new Set(texts.map(choiceShapeScore));
  return shapes.size <= 3;
}

function isAlphabetizedByText(choices: QuizChoiceLike[]): boolean {
  const texts = choices.map(choice => asString(choice.text).toLowerCase());
  if (texts.some(text => !text)) return false;
  const sorted = [...texts].sort((a, b) => a.localeCompare(b));
  return texts.every((text, index) => text === sorted[index]);
}

function countReasoningSteps(reasoningChain: string): number {
  if (!reasoningChain) return 0;
  const normalized = reasoningChain
    .replace(/->|=>|→/g, "|")
    .replace(/\bthen\b/gi, "|")
    .replace(/\btherefore\b/gi, "|")
    .replace(/\bthus\b/gi, "|")
    .replace(/[;]+/g, "|");
  const steps = normalized
    .split("|")
    .map(part => normalizeText(part))
    .filter(Boolean);
  return new Set(steps).size;
}

function includesDiagnosisTerm(stem: string, candidateTerm: string): boolean {
  const term = normalizeText(candidateTerm);
  if (!term) return false;
  return normalizeText(stem).includes(term);
}

function validateContentExtraction(item: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const extraction = item.content_extraction;
  if (!isPlainObject(extraction)) {
    errors.push(`${path}.content_extraction_missing`);
    return errors;
  }
  const concepts = Array.isArray(extraction.concepts) ? extraction.concepts : [];
  if (!concepts.length) {
    errors.push(`${path}.content_extraction.concepts_missing`);
    return errors;
  }
  concepts.forEach((concept, idx) => {
    if (!isPlainObject(concept)) {
      errors.push(`${path}.content_extraction.concepts[${idx}]_invalid`);
      return;
    }
    const topic = asString(concept.topic);
    const facts = gatherStringArray(concept.facts);
    if (!topic) errors.push(`${path}.content_extraction.concepts[${idx}].topic_missing`);
    if (facts.length < 2) errors.push(`${path}.content_extraction.concepts[${idx}].facts_lt_2`);
  });
  return errors;
}

function validateDifferentialSet(item: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const differentialSet = item.differential_set;
  if (!isPlainObject(differentialSet)) {
    errors.push(`${path}.differential_set_missing`);
    return errors;
  }
  const target = getDifferentialTarget(differentialSet);
  if (!target) {
    errors.push(`${path}.differential_set.target_missing`);
  }
  const competitors = gatherStringArray(differentialSet.competitors);
  if (competitors.length !== 4) {
    errors.push(`${path}.differential_set.competitors_must_be_4`);
  }
  const normalizedCompetitors = competitors.map(normalizeText);
  const uniqueCompetitors = new Set(normalizedCompetitors);
  if (uniqueCompetitors.size !== normalizedCompetitors.length) {
    errors.push(`${path}.differential_set.competitors_not_unique`);
  }
  if (target && uniqueCompetitors.has(normalizeText(target))) {
    errors.push(`${path}.differential_set.target_in_competitors`);
  }
  return errors;
}

function validateBlueprint(item: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const blueprint = item.blueprint;
  if (!isPlainObject(blueprint)) {
    errors.push(`${path}.blueprint_missing`);
    return errors;
  }
  if (!asString(blueprint.disease_tested)) errors.push(`${path}.blueprint.disease_tested_missing`);
  const taskType = asString(blueprint.task_type).toLowerCase();
  if (!taskType || !["diagnosis", "mechanism", "management", "complication"].includes(taskType)) {
    errors.push(`${path}.blueprint.task_type_invalid`);
  }
  if (gatherStringArray(blueprint.differential_diagnoses).length < 2) {
    errors.push(`${path}.blueprint.differential_diagnoses_lt_2`);
  }
  if (gatherStringArray(blueprint.key_discriminators).length < 2) {
    errors.push(`${path}.blueprint.key_discriminators_lt_2`);
  }
  if (!asString(blueprint.trap_mechanism)) errors.push(`${path}.blueprint.trap_mechanism_missing`);
  const reasoningChain = asString(blueprint.reasoning_chain);
  if (!reasoningChain) {
    errors.push(`${path}.blueprint.reasoning_chain_missing`);
  } else if (countReasoningSteps(reasoningChain) < 3) {
    errors.push(`${path}.blueprint.reasoning_chain_lt_3_steps`);
  }
  return errors;
}

function validateEvidenceMapForQuestion(question: QuizQuestionLike, item: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const stem = asString(question.stem);
  const rationale = asString(question.rationale) || asString(question.explanation);
  const evidenceMap = item.evidence_map;
  if (!isPlainObject(evidenceMap)) {
    errors.push(`${path}.evidence_map_missing`);
    return errors;
  }

  if (!asString(evidenceMap.correct_dx)) {
    errors.push(`${path}.correct_dx_missing`);
  }

  const supports = Array.isArray(evidenceMap.supports) ? evidenceMap.supports : [];
  if (supports.length < 2) {
    errors.push(`${path}.supports_lt_2`);
  }
  const supportDiscriminators = new Set<string>();
  const supportEvidence = new Set<string>();
  let correctDxPlausible = false;

  supports.forEach((support, idx) => {
    if (!isPlainObject(support)) {
      errors.push(`${path}.supports[${idx}]_invalid`);
      return;
    }
    const discriminator = asString(support.discriminator);
    const stemEvidence = asString(support.stem_evidence);
    if (!discriminator) {
      errors.push(`${path}.supports[${idx}].discriminator_missing`);
    } else {
      supportDiscriminators.add(normalizeText(discriminator));
    }
    if (!stemEvidence) {
      errors.push(`${path}.supports[${idx}].stem_evidence_missing`);
      return;
    }
    supportEvidence.add(normalizeText(stemEvidence));
    if (!stemIncludesEvidence(stem, stemEvidence)) {
      errors.push(`${path}.supports[${idx}].stem_evidence_not_in_stem`);
    } else {
      correctDxPlausible = true;
    }
  });

  if (supportDiscriminators.size < 2 || supportEvidence.size < 2) {
    errors.push(`${path}.single_clue_shortcut_risk`);
  }

  const differential = Array.isArray(evidenceMap.differential) ? evidenceMap.differential : [];
  if (!differential.length) {
    errors.push(`${path}.differential_missing`);
  }
  let matchingWouldFitClues = 0;
  let plausibleOptionCount = correctDxPlausible ? 1 : 0;
  differential.forEach((entry, entryIdx) => {
    if (!isPlainObject(entry)) {
      errors.push(`${path}.differential[${entryIdx}]_invalid`);
      return;
    }
    const dx = asString(entry.dx);
    if (!dx) {
      errors.push(`${path}.differential[${entryIdx}].dx_missing`);
    }

    const wouldFit = gatherStringList(entry.would_fit);
    if (!wouldFit.length) {
      errors.push(`${path}.differential[${entryIdx}].would_fit_missing`);
    } else if (wouldFit.some(clue => stemIncludesEvidence(stem, clue))) {
      matchingWouldFitClues += 1;
      plausibleOptionCount += 1;
    }

    const ruledOutBy = Array.isArray(entry.ruled_out_by) ? entry.ruled_out_by : [];
    if (!ruledOutBy.length) {
      errors.push(`${path}.differential[${entryIdx}].ruled_out_by_missing`);
      return;
    }
    ruledOutBy.forEach((rule, ruleIdx) => {
      if (!isPlainObject(rule)) {
        errors.push(`${path}.differential[${entryIdx}].ruled_out_by[${ruleIdx}]_invalid`);
        return;
      }
      const discriminator = asString(rule.discriminator);
      const stemEvidence = asString(rule.stem_evidence);
      if (!discriminator) {
        errors.push(`${path}.differential[${entryIdx}].ruled_out_by[${ruleIdx}].discriminator_missing`);
      }
      if (!stemEvidence) {
        errors.push(`${path}.differential[${entryIdx}].ruled_out_by[${ruleIdx}].stem_evidence_missing`);
        return;
      }
      if (!stemIncludesEvidence(stem, stemEvidence)) {
        errors.push(`${path}.differential[${entryIdx}].ruled_out_by[${ruleIdx}].stem_evidence_not_in_stem`);
      }
    });
  });

  if (differential.length && matchingWouldFitClues < 1) {
    errors.push(`${path}.differential_competition_not_visible_in_stem`);
  }
  if (plausibleOptionCount < 3) {
    errors.push(`${path}.plausible_options_lt_3`);
  }

  const conflictRule = asString(evidenceMap.conflict_rule);
  if (conflictRule) {
    const rationaleLower = rationale.toLowerCase();
    const hasOverrideLanguage = OVERRIDE_HINTS.some(hint => rationaleLower.includes(hint));
    if (!hasOverrideLanguage) {
      errors.push(`${path}.conflict_rule_not_explained`);
    }
  }

  return errors;
}

function validateDiagnosisLeakage(question: QuizQuestionLike, item: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const stem = asString(question.stem);
  if (!stem) return errors;

  const blueprint = isPlainObject(item.blueprint) ? item.blueprint : undefined;
  const differentialSet = isPlainObject(item.differential_set) ? item.differential_set : undefined;
  const evidenceMap = isPlainObject(item.evidence_map) ? item.evidence_map : undefined;

  const terms = [
    blueprint ? asString(blueprint.disease_tested) : "",
    differentialSet ? getDifferentialTarget(differentialSet) : "",
    evidenceMap ? asString(evidenceMap.correct_dx) : "",
  ].filter(Boolean);

  for (const term of terms) {
    if (includesDiagnosisTerm(stem, term)) {
      errors.push(`${path}.diagnosis_named_in_stem`);
      break;
    }
  }
  return errors;
}

function validateDifferentialOptionAlignment(question: QuizQuestionLike, item: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const blueprint = isPlainObject(item.blueprint) ? item.blueprint : undefined;
  const taskType = blueprint ? asString(blueprint.task_type).toLowerCase() : "";
  if (taskType !== "diagnosis") return errors;

  const differentialSet = item.differential_set;
  if (!isPlainObject(differentialSet)) return errors;

  const target = getDifferentialTarget(differentialSet);
  const competitors = gatherStringArray(differentialSet.competitors);
  const choices = normalizeQuestionChoices(question);
  const choiceTexts = choices.map(choice => normalizeText(asString(choice.text))).filter(Boolean);

  if (target) {
    const targetFound = choiceTexts.some(text => text.includes(normalizeText(target)));
    if (!targetFound) {
      errors.push(`${path}.differential_set.target_not_in_options`);
    }
  }

  const missingCompetitors = competitors.filter(competitor => {
    const normalizedCompetitor = normalizeText(competitor);
    return normalizedCompetitor && !choiceTexts.some(text => text.includes(normalizedCompetitor));
  });
  if (missingCompetitors.length > 1) {
    errors.push(`${path}.differential_set.competitors_not_reflected_in_options`);
  }
  return errors;
}

function validateOptionDiscipline(question: QuizQuestionLike, path: string): string[] {
  const errors: string[] = [];
  const choices = normalizeQuestionChoices(question);
  if (choices.length !== 5) {
    errors.push(`${path}.choices_count_invalid`);
    return errors;
  }
  if (!looksHomogeneous(choices)) {
    errors.push(`${path}.choices_not_homogeneous`);
  }
  if (!isAlphabetizedByText(choices)) {
    errors.push(`${path}.choices_not_alphabetized`);
  }
  return errors;
}

function validateRationale(question: QuizQuestionLike, path: string): string[] {
  const errors: string[] = [];
  const rationale = asString(question.rationale) || asString(question.explanation);
  const answer = asString(question.answer).toUpperCase();
  const choices = normalizeQuestionChoices(question);
  const labels = choices
    .map(choice => asString(choice.id).toUpperCase())
    .filter(Boolean);

  if (!/^\s*correct\s*\([A-E]\)\s*:/i.test(rationale)) {
    errors.push(`${path}.rationale_missing_correct_prefix`);
  }
  if (answer && !rationale.toLowerCase().includes(`correct (${answer.toLowerCase()})`)) {
    errors.push(`${path}.rationale_missing_correct_answer_label`);
  }
  for (const label of labels) {
    if (!rationaleMentionsLabel(rationale, label)) {
      errors.push(`${path}.rationale_missing_option_${label}`);
    }
  }
  return errors;
}

function validateDistractorMisconceptions(question: QuizQuestionLike, item: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const answer = asString(question.answer).toUpperCase();
  const choices = normalizeQuestionChoices(question);
  const nonAnswerIds = choices
    .map(choice => asString(choice.id).toUpperCase())
    .filter(id => id && id !== answer);

  const misconceptions = Array.isArray(item.distractor_misconceptions) ? item.distractor_misconceptions : [];
  if (!misconceptions.length) {
    errors.push(`${path}.distractor_misconceptions_missing`);
    return errors;
  }

  const mapped = new Map<string, { misconception: string; whyIncorrect: string }>();
  misconceptions.forEach((entry, idx) => {
    if (!isPlainObject(entry)) {
      errors.push(`${path}.distractor_misconceptions[${idx}]_invalid`);
      return;
    }
    const optionId = asString(entry.option_id).toUpperCase();
    const misconception = asString(entry.misconception);
    const whyIncorrect = asString(entry.why_incorrect);
    if (!optionId) {
      errors.push(`${path}.distractor_misconceptions[${idx}].option_id_missing`);
      return;
    }
    mapped.set(optionId, { misconception, whyIncorrect });
  });

  for (const optionId of nonAnswerIds) {
    const detail = mapped.get(optionId);
    if (!detail) {
      errors.push(`${path}.distractor_misconceptions_missing_${optionId}`);
      continue;
    }
    if (!detail.misconception) {
      errors.push(`${path}.distractor_misconceptions_${optionId}_misconception_missing`);
    }
    if (!detail.whyIncorrect) {
      errors.push(`${path}.distractor_misconceptions_${optionId}_why_incorrect_missing`);
    }
  }

  return errors;
}

function validateInternalContract(batchCandidate: unknown, internalContract: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(batchCandidate)) {
    return ["final_quiz_not_object"];
  }
  const batch = batchCandidate as QuizBatchLike;
  const questionsRaw = Array.isArray(batch.questions) ? batch.questions : [];
  const questions = questionsRaw.filter(isPlainObject) as QuizQuestionLike[];

  if (!isPlainObject(internalContract)) {
    return ["internal_contract_missing"];
  }

  const pipelineVersion = asString(internalContract.pipeline_version);
  if (!pipelineVersion) {
    errors.push("internal_contract.pipeline_version_missing");
  }

  const repair = internalContract.repair;
  if (!isPlainObject(repair)) {
    errors.push("internal_contract.repair_missing");
  } else if (!Object.prototype.hasOwnProperty.call(repair, "attempted")) {
    errors.push("internal_contract.repair.attempted_missing");
  }

  const itemsRaw = Array.isArray(internalContract.items) ? internalContract.items : [];
  const items = itemsRaw.filter(isPlainObject) as Record<string, unknown>[];
  if (!items.length) {
    errors.push("internal_contract.items_missing");
    return errors;
  }

  if (items.length < questions.length) {
    errors.push("internal_contract.items_lt_questions");
  }

  questions.forEach((question, index) => {
    const itemPath = `internal_contract.items[${index}]`;
    const item = getQuestionByIdOrIndex(questions, items, index);
    if (!item) {
      errors.push(`${itemPath}_missing`);
      return;
    }

    errors.push(...validateContentExtraction(item, itemPath));
    errors.push(...validateDifferentialSet(item, itemPath));
    errors.push(...validateBlueprint(item, itemPath));
    errors.push(...validateEvidenceMapForQuestion(question, item, itemPath));
    errors.push(...validateDiagnosisLeakage(question, item, `questions[${index}]`));
    errors.push(...validateDifferentialOptionAlignment(question, item, itemPath));
    errors.push(...validateOptionDiscipline(question, `questions[${index}]`));
    errors.push(...validateRationale(question, `questions[${index}]`));
    errors.push(...validateDistractorMisconceptions(question, item, itemPath));
  });

  return errors;
}

export function coerceQuizBatchCandidate(candidate: unknown, ctx: QuizBatchCoercionContext): unknown {
  if (!isPlainObject(candidate)) return candidate;
  if (isLegacyBatchShape(candidate)) return candidate;
  if (!isStage3QuizShape(candidate)) return candidate;

  const questionsRaw = Array.isArray(candidate.questions) ? candidate.questions : [];
  const questions = questionsRaw.filter(isPlainObject) as QuizQuestionLike[];
  const setSize = asInteger(candidate.setSize) || questions.length || ctx.expectedCount;
  const lectureTitle = asString(candidate.lectureTitle) || ctx.lectureTitle || ctx.lectureId;
  const lectureId = asString(candidate.lectureId) || ctx.lectureId;

  return {
    lectureId,
    lectureTitle,
    setSize,
    questions: questions.map((question, index) => normalizeQuestionToLegacy(question, index)),
  };
}

export function inspectQuizPipelineOutput(candidate: unknown): QuizPipelineInspection {
  if (!isPlainObject(candidate)) {
    return {
      source: "legacy",
      batchCandidate: candidate,
      internalErrors: [],
      debugFlag: false,
      reportedFailedChecks: [],
    };
  }

  const asPipeline = candidate as Record<string, unknown>;
  const hasFinalQuiz = Object.prototype.hasOwnProperty.call(asPipeline, "final_quiz");
  if (!hasFinalQuiz) {
    return {
      source: "legacy",
      batchCandidate: candidate,
      internalErrors: [],
      debugFlag: false,
      reportedFailedChecks: [],
    };
  }

  const internalContract = asPipeline.internal_contract;
  const repair = isPlainObject(internalContract) && isPlainObject(internalContract.repair)
    ? (internalContract.repair as Record<string, unknown>)
    : undefined;
  const debugFlag = repair ? asBool(repair.debug_flag) : false;

  const items = isPlainObject(internalContract) && Array.isArray(internalContract.items)
    ? internalContract.items
    : [];
  const reportedFailedChecks = [
    ...(repair ? gatherStringArray(repair.failed_checks) : []),
    ...items.flatMap(gatherChecksFromItem),
  ];

  return {
    source: "pipeline",
    batchCandidate: asPipeline.final_quiz,
    internalErrors: validateInternalContract(asPipeline.final_quiz, internalContract),
    debugFlag,
    reportedFailedChecks,
  };
}
