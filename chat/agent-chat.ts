import type { Env } from "../../types";
import { ALLOWED_MODELS } from "../runtime/model-selection";
import { jsonNoStore } from "../runtime/http";
import { handleChatContinueRoute as handleRuntimeChatContinueRoute, handleChatRoute as handleRuntimeChatRoute } from "./runtime/stream-engine";

export function handleChatRoute(request: Request, env: Env): Promise<Response> {
  return handleRuntimeChatRoute(request, env);
}

export function handleChatContinueRoute(request: Request, env: Env): Promise<Response> {
  return handleRuntimeChatContinueRoute(request, env);
}

export function handleChatModelsRoute(_request: Request, _env: Env): Promise<Response> {
  return Promise.resolve(jsonNoStore({ models: ALLOWED_MODELS }));
}
