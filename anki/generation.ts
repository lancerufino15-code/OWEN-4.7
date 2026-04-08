import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";
export { __setAnkiEmbeddedPagesExtractorForTests } from "../runtime/legacy-core";

export function handleAnkiGenerateRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
