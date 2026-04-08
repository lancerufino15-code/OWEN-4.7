import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";

export function handleLibraryQbankUploadRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryQbankSaveFromQuizRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
