import type { Env } from "../../../types";
import { getRuntimeFeatures } from "../config/runtime-features";
import { createMockModelAdapter } from "./mock_adapter";
import { DEFAULT_MOCK_MODEL_FIXTURES, type MockModelFixtureCatalog } from "./fixtures";
import { createRealModelAdapter } from "./real_adapter";

export type ModelAdapterEndpoint = "responses" | "chat_completions";

export interface ModelAdapterRequest {
  endpoint: ModelAdapterEndpoint;
  payload: Record<string, unknown>;
  label: string;
}

export interface ModelAdapterFrame {
  eventName?: string;
  payload: any;
}

export interface ModelAdapterSendResult {
  raw: any;
  text: string;
  finishReason?: string;
  status?: string;
  outputTokens?: number;
  incompleteReason?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  } | null;
}

export interface ModelAdapter {
  send(request: ModelAdapterRequest): Promise<ModelAdapterSendResult>;
  streamFrames(request: ModelAdapterRequest): AsyncGenerator<ModelAdapterFrame>;
}

type ModelAdapterFactory = (env: Env) => ModelAdapter;

let modelAdapterFactoryOverride: ModelAdapterFactory | null = null;
let mockFixtureCatalogOverride: MockModelFixtureCatalog | null = null;

export function __setModelAdapterFactoryForTests(factory: ModelAdapterFactory | null) {
  modelAdapterFactoryOverride = factory;
}

export function __setMockModelFixtureCatalogForTests(catalog: MockModelFixtureCatalog | null) {
  mockFixtureCatalogOverride = catalog;
}

export function resolveModelAdapter(env: Env): ModelAdapter {
  if (modelAdapterFactoryOverride) {
    return modelAdapterFactoryOverride(env);
  }
  const features = getRuntimeFeatures(env);
  if (features.parityFixtureMode.enabled) {
    return createMockModelAdapter(mockFixtureCatalogOverride || DEFAULT_MOCK_MODEL_FIXTURES);
  }
  return createRealModelAdapter(env);
}
