import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";

export function handleLibraryQuizRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
