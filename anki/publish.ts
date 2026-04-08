import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";

export function handleAnkiPublishRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
