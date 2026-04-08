import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";

export function handleUploadRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleGenerateFileRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
