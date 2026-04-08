import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";

export function handleLibraryIngestRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryBatchIngestRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryBatchIndexRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryTxtUploadRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
