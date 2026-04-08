import { DEFAULT_TEXT_MODEL } from "../model_defaults";
import type { Env } from "../types";

export type RuntimeModelDomain = "chat" | "quiz" | "study-guide" | "anki" | "image";
export type RuntimeModelProvider = "openai" | "google";

export interface RuntimeModelDef {
  id: string;
  domain: RuntimeModelDomain;
  provider: RuntimeModelProvider;
  defaultModelId: string;
  envVar?: keyof Env;
  fallbackIds?: string[];
}

export interface ConfiguredRuntimeModelDef extends RuntimeModelDef {
  configuredModelId: string;
}

export const MODEL_REGISTRY: RuntimeModelDef[] = [
  {
    id: "chat.default",
    domain: "chat",
    provider: "openai",
    defaultModelId: DEFAULT_TEXT_MODEL,
    envVar: "DEFAULT_TEXT_MODEL",
    fallbackIds: [DEFAULT_TEXT_MODEL, "gpt-5.2"],
  },
  {
    id: "study-guide.default",
    domain: "study-guide",
    provider: "openai",
    defaultModelId: DEFAULT_TEXT_MODEL,
    envVar: "DEFAULT_TEXT_MODEL",
    fallbackIds: [DEFAULT_TEXT_MODEL, "gpt-5.2"],
  },
  {
    id: "anki.default",
    domain: "anki",
    provider: "openai",
    defaultModelId: DEFAULT_TEXT_MODEL,
    envVar: "DEFAULT_TEXT_MODEL",
    fallbackIds: [DEFAULT_TEXT_MODEL, "gpt-5.2"],
  },
  {
    id: "quiz.default",
    domain: "quiz",
    provider: "google",
    defaultModelId: "gemini-3.1-pro-preview",
    envVar: "GEMINI_QUIZ_MODEL",
    fallbackIds: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "image.default",
    domain: "image",
    provider: "openai",
    defaultModelId: "gpt-image-1",
    envVar: "GPT_IMAGE_1_MODEL_ID",
    fallbackIds: ["gpt-image-1-mini", "dall-e-3", "dall-e-2"],
  },
];

export function getModelRegistry(): RuntimeModelDef[] {
  return MODEL_REGISTRY;
}

export function resolveConfiguredModels(env: Env): ConfiguredRuntimeModelDef[] {
  return MODEL_REGISTRY.map((entry) => {
    const configured = entry.envVar ? env[entry.envVar] : undefined;
    return {
      ...entry,
      configuredModelId: typeof configured === "string" && configured.trim() ? configured.trim() : entry.defaultModelId,
    };
  });
}
