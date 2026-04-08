import { DEFAULT_TEXT_MODEL } from "../../model_defaults";
import type { Env } from "../../types";
export { validateRuntimeEnv } from "./env";

export const ALLOWED_MODELS = [
  DEFAULT_TEXT_MODEL,
  "gpt-image-1",
  "gpt-image-1-mini",
  "dall-e-3",
  "dall-e-2",
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];
export type OpenAIEndpoint = "responses" | "chat_completions";
export type SamplingEnv = { OWEN_STRIP_SAMPLING_PARAMS?: string; DEFAULT_TEXT_MODEL?: string };

type ModelSamplingSupport = {
  supportsTemperature: boolean;
  supportsTopP: boolean;
};

const IMAGE_MODELS = new Set<string>(["gpt-image-1", "gpt-image-1-mini", "dall-e-3", "dall-e-2"]);

const MODEL_FALLBACKS: Partial<Record<AllowedModel, AllowedModel[]>> = {
  [DEFAULT_TEXT_MODEL]: [],
  "gpt-image-1": ["gpt-image-1-mini", "dall-e-3", "dall-e-2"],
  "gpt-image-1-mini": ["dall-e-3", "dall-e-2"],
  "dall-e-3": ["dall-e-2"],
  "dall-e-2": [],
};

const MODEL_ALIAS_RESOLVERS: Partial<Record<AllowedModel, (env: Env) => string>> = {
  [DEFAULT_TEXT_MODEL]: getConfiguredDefaultTextModel,
  "gpt-image-1": (env) => env.GPT_IMAGE_1_MODEL_ID?.trim() || "gpt-image-1",
  "gpt-image-1-mini": (env) => env.GPT_IMAGE_1_MINI_MODEL_ID?.trim() || "gpt-image-1-mini",
  "dall-e-3": (env) => env.DALLE3_MODEL_ID?.trim() || "dall-e-3",
  "dall-e-2": (env) => env.DALLE2_MODEL_ID?.trim() || "dall-e-2",
};

const DEFAULT_MODEL_SAMPLING_SUPPORT: ModelSamplingSupport = {
  supportsTemperature: true,
  supportsTopP: true,
};

const MODEL_SAMPLING_CAPABILITIES: Record<
  string,
  Partial<Record<OpenAIEndpoint, ModelSamplingSupport>> & { default?: ModelSamplingSupport }
> = {
  [DEFAULT_TEXT_MODEL]: { responses: { supportsTemperature: false, supportsTopP: false } },
};

function normalizeModelKey(model?: string | null): string {
  return (model || "").trim().toLowerCase();
}

function resolveSamplingSupport(
  model: string,
  endpoint: OpenAIEndpoint,
  env?: SamplingEnv,
  forceStripSampling?: boolean,
): ModelSamplingSupport {
  if (forceStripSampling || env?.OWEN_STRIP_SAMPLING_PARAMS === "1") {
    return { supportsTemperature: false, supportsTopP: false };
  }
  const normalized = normalizeModelKey(model);
  if (!normalized) return DEFAULT_MODEL_SAMPLING_SUPPORT;
  const configuredDefaultModel = normalizeModelKey(env?.DEFAULT_TEXT_MODEL);
  if (configuredDefaultModel && normalized === configuredDefaultModel) {
    const entry = MODEL_SAMPLING_CAPABILITIES[DEFAULT_TEXT_MODEL];
    return entry?.[endpoint] || entry?.default || DEFAULT_MODEL_SAMPLING_SUPPORT;
  }
  if (MODEL_SAMPLING_CAPABILITIES[normalized]) {
    const entry = MODEL_SAMPLING_CAPABILITIES[normalized];
    return entry?.[endpoint] || entry?.default || DEFAULT_MODEL_SAMPLING_SUPPORT;
  }
  for (const [key, entry] of Object.entries(MODEL_SAMPLING_CAPABILITIES)) {
    if (normalized.startsWith(key)) {
      return entry?.[endpoint] || entry?.default || DEFAULT_MODEL_SAMPLING_SUPPORT;
    }
  }
  return DEFAULT_MODEL_SAMPLING_SUPPORT;
}

export function isAllowedModel(model: string | undefined | null): model is AllowedModel {
  return typeof model === "string" && (ALLOWED_MODELS as readonly string[]).includes(model);
}

export function isImageModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return IMAGE_MODELS.has(model.toLowerCase());
}

export function getConfiguredDefaultTextModel(env: Env): string {
  const configured = env.DEFAULT_TEXT_MODEL?.trim();
  if (!configured) {
    throw new Error("DEFAULT_TEXT_MODEL missing from env. Check .dev.vars");
  }
  return configured;
}

export function getDefaultModel(env: Env): AllowedModel {
  getConfiguredDefaultTextModel(env);
  return DEFAULT_TEXT_MODEL;
}

export function resolveModelId(model: AllowedModel, env: Env): string {
  const resolver = MODEL_ALIAS_RESOLVERS[model];
  const resolved = resolver ? resolver(env) : model;
  return resolved || model;
}

export function buildModelChain(requested: AllowedModel): AllowedModel[] {
  const chain: AllowedModel[] = [];
  const enqueue = (model: string) => {
    if (isAllowedModel(model) && !chain.includes(model)) chain.push(model);
  };
  enqueue(requested);
  (MODEL_FALLBACKS[requested] || []).forEach(enqueue);
  return chain;
}

export function resolveModelSamplingSupport(
  model: string,
  endpoint: OpenAIEndpoint,
  env?: SamplingEnv,
  forceStripSampling?: boolean,
): { supportsTemperature: boolean; supportsTopP: boolean } {
  return resolveSamplingSupport(model, endpoint, env, forceStripSampling);
}
