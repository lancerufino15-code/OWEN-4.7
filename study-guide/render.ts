import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";

export function handleMachineGenerateStudyGuideRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleMachineDownloadRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handlePublishStudyGuideRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleRetrieveStudyGuideRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleStudyGuideAssetRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
