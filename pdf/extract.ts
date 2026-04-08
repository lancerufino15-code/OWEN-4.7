import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";

export function handlePdfIngestRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleAskFileRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleAskDocRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleExtractRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
