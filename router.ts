import { handleApiRequest } from "./routes/api";
import { handleAssetRequest } from "./routes/assets";
import type { Env } from "./types";

export async function routeRequest(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/api/")) {
    return handleApiRequest(request, env);
  }
  return handleAssetRequest(request, env);
}
