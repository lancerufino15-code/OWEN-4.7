import { DEFAULT_TEXT_MODEL } from "../../model_defaults";
import type { StepAOutput, StepBOutput } from "../../machine/render_study_guide_html";
import {
  validateStepB,
  validateSynthesis,
  type StepBValidationFailure,
  type StepBSynthesisFailure,
} from "../../machine/study_guide_stepB_validator";
import {
  STUDY_GUIDE_STEP_B1_OUTLINE_PROMPT,
  STUDY_GUIDE_STEP_B2_PACK_JSON_PROMPT,
  STUDY_GUIDE_STEP_B2_REWRITE_JSON_PROMPT,
  STUDY_GUIDE_STEP_B_DRAFT_PROMPT,
  STUDY_GUIDE_STEP_B_PLAN_PROMPT,
  STUDY_GUIDE_STEP_B_SYNTHESIS_REWRITE_PROMPT,
} from "../../registry/prompts";
import type { Env } from "../../types";
import { sanitizeOpenAIPayload } from "../chat/openai";
import { resolveModelAdapter } from "../runtime/model/adapter";
import { resolveModelId } from "../runtime/model-selection";
import { trackUsageEvent } from "../runtime/usage/tracker";
import { buildFallbackPlanFromStepA, buildFallbackStepBOutput } from "./fallback";
import {
  applyStudyGuidePromptTemplate,
  extractFirstJsonObject,
  parseStudyGuideJsonWithRepair,
} from "./json";

const MACHINE_STUDY_GUIDE_MAX_OUTPUT_TOKENS = 20_000;
const MACHINE_STUDY_GUIDE_STEP_B_MAX_OUTPUT_TOKENS = 5_000;
const MACHINE_STUDY_GUIDE_STEP_B_PLAN_MAX_OUTPUT_TOKENS = 1_200;
const MACHINE_STUDY_GUIDE_STEP_B_PLAN_RETRY_MAX_OUTPUT_TOKENS = 800;
const MACHINE_STUDY_GUIDE_STEP_B1_OUTLINE_MAX_OUTPUT_TOKENS = 2_000;
const MACHINE_STUDY_GUIDE_STEP_B_QC_REWRITE_MAX_OUTPUT_TOKENS = 3_500;
const MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS = 2_000;
const STUDY_GUIDE_TEMPERATURE = 0;
const STUDY_GUIDE_TOP_P = 1;
const STUDY_GUIDE_STEP_B_REPAIR_PROMPT =
  "Repair the following JSON so it is valid and preserves the intended structure. Return only JSON.\n\n";

type TokenLimit = { max_tokens?: number; max_completion_tokens?: number };

type OpenAIJson = Record<string, unknown>;

type ResponseCallResult = {
  text: string;
  finishReason?: string;
  status?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  } | null;
  raw?: OpenAIJson;
};

type StepBPlan = {
  selected_exam_atoms: string[];
  section_counts: {
    high_yield_summary: number;
    one_page_last_minute_review: number;
    rapid_approach_table_rows: number;
    compare_topics: number;
    compare_rows_per_topic: number;
  };
  compare_topics: string[];
  atom_to_section_map: Array<{ atom: string; section: string }>;
  warnings?: string[];
};

type StepBStageDiagnostic = {
  step: string;
  model?: string;
  parse_ok?: boolean;
  exception?: string;
  stack?: string;
};

type StepBCompileResult = {
  plan: StepBPlan;
  outline: string;
  draft: StepBOutput;
  final: StepBOutput;
  failures: StepBValidationFailure[];
  finalFailures: StepBValidationFailure[];
  hadRewrite: boolean;
  coerced: boolean;
};

function extractOutputText(payload: any): string {
  if (!payload) return "";
  const stringifyContent = (content: any[]): string =>
    content
      .map((part: any) => {
        if (typeof part?.text === "string") return part.text;
        if (part && typeof part.json === "object") return JSON.stringify(part.json);
        return "";
      })
      .filter(Boolean)
      .join("");

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
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
    const joined = payload.output
      .map((item: any) => (Array.isArray(item?.content) ? stringifyContent(item.content) : ""))
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  if (Array.isArray(payload.response?.output)) {
    const joined = payload.response.output
      .map((item: any) => (Array.isArray(item?.content) ? stringifyContent(item.content) : ""))
      .filter(Boolean)
      .join("\n");
    if (joined.trim()) return joined;
  }
  return "";
}

function extractFinishReason(payload: any): string | undefined {
  const direct = payload?.finish_reason ?? payload?.response?.finish_reason;
  if (typeof direct === "string" && direct.trim()) return direct;
  const output = Array.isArray(payload?.output) ? payload.output : Array.isArray(payload?.response?.output) ? payload.response.output : [];
  for (const item of output) {
    if (typeof item?.status === "string" && item.status.trim()) return item.status;
    if (typeof item?.finish_reason === "string" && item.finish_reason.trim()) return item.finish_reason;
  }
  return undefined;
}

function extractResponseStatus(payload: any): string | undefined {
  const status = payload?.status ?? payload?.response?.status;
  return typeof status === "string" && status.trim() ? status : undefined;
}

/**
 * Build a token-limit parameter object for the given model/API type.
 */
export function buildTokenLimit(model: string, desired: number, apiType: "chat" | "responses" = "chat"): TokenLimit {
  const normalized = (model || "").toLowerCase();
  const needsMaxCompletion =
    apiType === "responses" ||
    normalized === DEFAULT_TEXT_MODEL ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3");
  return needsMaxCompletion ? { max_completion_tokens: desired } : { max_tokens: desired };
}

const STUDY_GUIDE_FORBIDDEN_KEYS = [
  "stop",
  "stop_sequences",
  "stopSequences",
  "response",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "max_completion_tokens",
  "max_tokens",
  "n",
  "stream",
] as const;

export function stripStudyGuideForbiddenKeys<T extends Record<string, unknown>>(payload: T): T {
  for (const key of STUDY_GUIDE_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      delete (payload as Record<string, unknown>)[key];
    }
  }
  return payload;
}

function sanitizeResponsesPayload(payload: Record<string, unknown>, model: string, env?: Env): Record<string, unknown> {
  const sanitized = sanitizeOpenAIPayload(payload, { endpoint: "responses", env, model });
  return stripStudyGuideForbiddenKeys(sanitized.payload);
}

export function buildStudyGuidePayload(
  model: string,
  prompt: string,
  maxTokens = MACHINE_STUDY_GUIDE_MAX_OUTPUT_TOKENS,
) {
  return withMaxOutputTokens(
    {
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      temperature: STUDY_GUIDE_TEMPERATURE,
      top_p: STUDY_GUIDE_TOP_P,
    },
    maxTokens,
  );
}

export function withMaxOutputTokens(payload: Record<string, unknown>, n: number) {
  payload.max_output_tokens = n;
  delete payload.max_completion_tokens;
  delete payload.max_tokens;
  return payload;
}

async function callResponsesOnce(env: Env, payload: Record<string, unknown>, label: string): Promise<ResponseCallResult> {
  const adapter = resolveModelAdapter(env);
  let result;
  try {
    result = await adapter.send({
      endpoint: "responses",
      payload,
      label,
    });
  } catch (error) {
    await trackUsageEvent(env, {
      requestId: `study-guide:${label}:${Date.now().toString(36)}`,
      route: "/api/machine/generate-study-guide",
      workflow: "study-guide.compile",
      artifactType: "study_guide",
      artifactCode: label,
      modelId: typeof payload.model === "string" ? payload.model : DEFAULT_TEXT_MODEL,
      provider: "openai",
      success: false,
      errorCode: error instanceof Error ? error.message : String(error),
      toolSet: [],
      usage: null,
      metadata: { label },
    }).catch(() => undefined);
    throw error;
  }
  await trackUsageEvent(env, {
    requestId: `study-guide:${label}:${Date.now().toString(36)}`,
    route: "/api/machine/generate-study-guide",
    workflow: "study-guide.compile",
    artifactType: "study_guide",
    artifactCode: label,
    modelId: typeof payload.model === "string" ? payload.model : DEFAULT_TEXT_MODEL,
    provider: "openai",
    success: true,
    toolSet: [],
    usage: result.usage,
    metadata: { label },
  }).catch(() => undefined);
  return {
    text: result.text || extractOutputText(result.raw).trim(),
    finishReason: result.finishReason || extractFinishReason(result.raw),
    status: result.status || extractResponseStatus(result.raw),
    usage: result.usage,
    raw: result.raw,
  };
}

function buildStepAPlanSlim(stepA: StepAOutput) {
  return {
    lecture_title: stepA.lecture_title,
    exam_atoms: stepA.exam_atoms || [],
    discriminators: stepA.discriminators || [],
    buckets: stepA.buckets,
  };
}

function buildOutlineFromStepB(stepB: StepBOutput): string {
  const lines: string[] = [];
  lines.push("HIGH_YIELD_SUMMARY:");
  for (const item of stepB.high_yield_summary || []) lines.push(`- ${item}`);
  lines.push("RAPID_APPROACH_TABLE:");
  for (const row of stepB.rapid_approach_table || []) {
    lines.push(`- ${row?.clue || ""} | ${row?.think_of || ""} | ${row?.why || ""} | ${row?.confirm || ""}`.trim());
  }
  lines.push("ONE_PAGE_LAST_MINUTE_REVIEW:");
  for (const item of stepB.one_page_last_minute_review || []) lines.push(`- ${item}`);
  return lines.filter(Boolean).join("\n").trim();
}

export async function compileStudyGuideStepB(opts: {
  stepA: StepAOutput;
  callModelOutline: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
  callModelJson: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
  modelOutline?: string;
  modelJson?: string;
  recordStage?: (entry: StepBStageDiagnostic) => void;
}): Promise<StepBCompileResult> {
  const recordStage = opts.recordStage;
  const modelJson = opts.modelJson;
  const stepAJson = JSON.stringify(opts.stepA, null, 2);
  const planStepAJson = JSON.stringify(buildStepAPlanSlim(opts.stepA), null, 2);
  const planPrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B_PLAN_PROMPT, {
    "{{STEP_A_JSON}}": planStepAJson,
  });
  const planPromptStrict = [
    planPrompt,
    "",
    "STRICT_JSON_ONLY:",
    "Return ONLY a single JSON object. No markdown. No commentary.",
    "End immediately after the final }.",
    "Do not include extra keys.",
  ].join("\n");

  let plan: StepBPlan | null = null;
  for (const attempt of [
    { step: "B-plan", prompt: planPrompt, maxOutputTokens: MACHINE_STUDY_GUIDE_STEP_B_PLAN_MAX_OUTPUT_TOKENS },
    {
      step: "B-plan-retry",
      prompt: planPromptStrict,
      maxOutputTokens: MACHINE_STUDY_GUIDE_STEP_B_PLAN_RETRY_MAX_OUTPUT_TOKENS,
    },
  ]) {
    let planRaw = "";
    try {
      planRaw = await opts.callModelJson(attempt.step, attempt.prompt, attempt.maxOutputTokens);
    } catch (err) {
      console.warn("[machine.studyGuide] step=%s plan call failed", attempt.step, {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!planRaw.trim()) continue;
    const extracted = extractFirstJsonObject(planRaw);
    if (!extracted) continue;
    try {
      plan = await parseStudyGuideJsonWithRepair<StepBPlan>(extracted, attempt.step, async (raw) => {
        const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
        return opts.callModelJson(`${attempt.step}-repair`, repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
      });
      recordStage?.({ step: `${attempt.step}:parse`, model: modelJson, parse_ok: true });
      break;
    } catch (err) {
      recordStage?.({
        step: `${attempt.step}:parse`,
        model: modelJson,
        parse_ok: false,
        exception: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  if (!plan) {
    plan = buildFallbackPlanFromStepA(opts.stepA);
    recordStage?.({ step: "B-plan-fallback", model: modelJson });
  }

  const fallbackStepB = buildFallbackStepBOutput(opts.stepA);
  const outlinePrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B1_OUTLINE_PROMPT, {
    "{{STEP_A_PLAN_JSON}}": planStepAJson,
    "{{SECTION_COUNTS_JSON}}": JSON.stringify(plan.section_counts, null, 2),
    "{{COMPARE_TOPICS_JSON}}": JSON.stringify(plan.compare_topics, null, 2),
  });

  let outline = "";
  try {
    outline = await opts.callModelOutline("B1-outline", outlinePrompt, MACHINE_STUDY_GUIDE_STEP_B1_OUTLINE_MAX_OUTPUT_TOKENS);
  } catch (err) {
    console.warn("[machine.studyGuide] step=B1 outline failed; using fallback outline", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!outline.trim()) {
    outline = buildOutlineFromStepB(fallbackStepB);
  }

  const packPrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B2_PACK_JSON_PROMPT, {
    "{{STEP_A_JSON}}": stepAJson,
    "{{STEP_B1_OUTLINE}}": outline,
  });

  let draft: StepBOutput;
  try {
    const draftRaw = await opts.callModelJson("B2-pack", packPrompt, MACHINE_STUDY_GUIDE_STEP_B_MAX_OUTPUT_TOKENS);
    draft = await parseStudyGuideJsonWithRepair<StepBOutput>(draftRaw, "B2-pack", async (raw) => {
      const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
      return opts.callModelJson("B2-pack-repair", repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
    });
    recordStage?.({ step: "B2-pack:parse", model: modelJson, parse_ok: true });
  } catch (err) {
    recordStage?.({
      step: "B2-pack:parse",
      model: modelJson,
      parse_ok: false,
      exception: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const coercedFailures = validateStepB(opts.stepA, fallbackStepB, plan.selected_exam_atoms);
    return {
      plan,
      outline,
      draft: fallbackStepB,
      final: fallbackStepB,
      failures: [],
      finalFailures: coercedFailures,
      hadRewrite: false,
      coerced: true,
    };
  }

  const failures = validateStepB(opts.stepA, draft, plan.selected_exam_atoms);
  if (!failures.length) {
    return { plan, outline, draft, final: draft, failures, finalFailures: [], hadRewrite: false, coerced: false };
  }

  const rewritePrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B2_REWRITE_JSON_PROMPT, {
    "{{STEP_A_JSON}}": stepAJson,
    "{{STEP_B1_OUTLINE}}": outline,
    "{{STEP_B_DRAFT_JSON}}": JSON.stringify(draft, null, 2),
    "{{STEP_B_FAILURES_JSON}}": JSON.stringify(failures, null, 2),
  });

  let final: StepBOutput;
  try {
    const rewriteRaw = await opts.callModelJson(
      "B2-rewrite",
      rewritePrompt,
      MACHINE_STUDY_GUIDE_STEP_B_QC_REWRITE_MAX_OUTPUT_TOKENS,
    );
    final = await parseStudyGuideJsonWithRepair<StepBOutput>(rewriteRaw, "B2-rewrite", async (raw) => {
      const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
      return opts.callModelJson("B2-rewrite-repair", repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
    });
    recordStage?.({ step: "B2-rewrite:parse", model: modelJson, parse_ok: true });
  } catch (err) {
    recordStage?.({
      step: "B2-rewrite:parse",
      model: modelJson,
      parse_ok: false,
      exception: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const coercedFailures = validateStepB(opts.stepA, fallbackStepB, plan.selected_exam_atoms);
    return {
      plan,
      outline,
      draft,
      final: fallbackStepB,
      failures,
      finalFailures: coercedFailures,
      hadRewrite: true,
      coerced: true,
    };
  }

  const finalFailures = validateStepB(opts.stepA, final, plan.selected_exam_atoms);
  if (finalFailures.length) {
    const coercedFailures = validateStepB(opts.stepA, fallbackStepB, plan.selected_exam_atoms);
    return {
      plan,
      outline,
      draft,
      final: fallbackStepB,
      failures,
      finalFailures: coercedFailures,
      hadRewrite: true,
      coerced: true,
    };
  }

  return { plan, outline, draft, final, failures, finalFailures, hadRewrite: true, coerced: false };
}

export async function enforceStepBSynthesisMinimums(opts: {
  stepA: StepAOutput;
  stepB: StepBOutput;
  plan: StepBPlan;
  callModel: (step: string, prompt: string, maxOutputTokens: number) => Promise<string>;
}): Promise<{ stepB: StepBOutput; failures: StepBSynthesisFailure[]; hadRewrite: boolean; hadRedraft: boolean }> {
  const stepAJson = JSON.stringify(opts.stepA, null, 2);
  const planJson = JSON.stringify(opts.plan, null, 2);
  let failures = validateSynthesis(opts.stepB);
  if (!failures.length) {
    return { stepB: opts.stepB, failures, hadRewrite: false, hadRedraft: false };
  }

  const rewritePrompt = applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B_SYNTHESIS_REWRITE_PROMPT, {
    "{{STEP_A_JSON}}": stepAJson,
    "{{STEP_B_PLAN_JSON}}": planJson,
    "{{STEP_B_DRAFT_JSON}}": JSON.stringify(opts.stepB, null, 2),
    "{{STEP_B_FAILURES_JSON}}": JSON.stringify(failures, null, 2),
  });

  try {
    const rewriteRaw = await opts.callModel(
      "B-synthesis-rewrite",
      rewritePrompt,
      MACHINE_STUDY_GUIDE_STEP_B_QC_REWRITE_MAX_OUTPUT_TOKENS,
    );
    const rewritten = await parseStudyGuideJsonWithRepair<StepBOutput>(rewriteRaw, "B-synthesis-rewrite", async (raw) => {
      const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
      return opts.callModel("B-synthesis-rewrite-repair", repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
    });
    failures = validateSynthesis(rewritten);
    if (!failures.length) {
      return { stepB: rewritten, failures, hadRewrite: true, hadRedraft: false };
    }
  } catch (err) {
    console.warn("[machine.studyGuide] step=B synthesis rewrite failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const strictDraftPrompt = [
    applyStudyGuidePromptTemplate(STUDY_GUIDE_STEP_B_DRAFT_PROMPT, {
      "{{STEP_A_JSON}}": stepAJson,
      "{{STEP_B_PLAN_JSON}}": planJson,
    }),
    "",
    "STRICT_MINIMA:",
    "Do not output empty arrays for high_yield_summary, rapid_approach_table, or one_page_last_minute_review.",
    "Ensure high_yield_summary >= 8, rapid_approach_table >= 10 rows, one_page_last_minute_review >= 12.",
    "If material is sparse, compress and reuse Step A facts; still meet counts.",
  ].join("\n");

  const redraftRaw = await opts.callModel(
    "B-synthesis-redraft",
    strictDraftPrompt,
    MACHINE_STUDY_GUIDE_STEP_B_MAX_OUTPUT_TOKENS,
  );
  const redraft = await parseStudyGuideJsonWithRepair<StepBOutput>(redraftRaw, "B-synthesis-redraft", async (raw) => {
    const repairPrompt = `${STUDY_GUIDE_STEP_B_REPAIR_PROMPT}${raw}`;
    return opts.callModel("B-synthesis-redraft-repair", repairPrompt, MACHINE_STUDY_GUIDE_STEP_B_REPAIR_MAX_OUTPUT_TOKENS);
  });
  failures = validateSynthesis(redraft);
  if (!failures.length) {
    return { stepB: redraft, failures, hadRewrite: true, hadRedraft: true };
  }

  const coerced = buildFallbackStepBOutput(opts.stepA);
  return {
    stepB: coerced,
    failures: validateSynthesis(coerced),
    hadRewrite: true,
    hadRedraft: true,
  };
}

export async function callStudyGuideResponses(
  env: Env,
  requestId: string,
  step: string,
  model: string,
  input: string,
  maxOutputTokens: number,
  opts?: { expectsJson?: boolean },
): Promise<string> {
  const rawPayload = buildStudyGuidePayload(model, input, maxOutputTokens) as Record<string, unknown>;
  const payload = sanitizeResponsesPayload(rawPayload, model, env);
  if (opts?.expectsJson) {
    payload.text = { format: { type: "json_object" } };
  }
  delete payload.max_completion_tokens;
  delete payload.max_tokens;

  const payloadModel = String(payload.model ?? "");
  if (payloadModel.toLowerCase() !== DEFAULT_TEXT_MODEL) {
    throw new Error(`Model override detected. Only ${DEFAULT_TEXT_MODEL} is allowed for study guides.`);
  }

  console.log("[machine.studyGuide] step=%s model=%s requestId=%s", step, payload.model, requestId);
  const resolvedPayload = {
    ...payload,
    model: resolveModelId(DEFAULT_TEXT_MODEL, env),
  };
  const result = await callResponsesOnce(env, resolvedPayload, `machine-study-guide:${requestId}:${step}`);
  const text = (result.text || "").trim();
  if (!text) {
    throw new Error(`Study guide step ${step} response was empty.`);
  }
  return text;
}
