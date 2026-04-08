import type { Env } from "../types";
import { defineRoute, type RouteDef } from "./base";

const OWEN_CLIENT_BUILD = "20260309-1";
const OWEN_CLIENT_ASSET_PATH = `/chat.${OWEN_CLIENT_BUILD}.js`;

export function rewriteLegacyClientAssetRequest(req: Request, assetUrl: URL): Request {
  if (assetUrl.pathname !== "/chat.js") return req;
  const versionedUrl = new URL(OWEN_CLIENT_ASSET_PATH, assetUrl.origin);
  return new Request(versionedUrl.toString(), req);
}

export async function prepareAssetResponse(resp: Response): Promise<Response> {
  if (resp.headers.get("content-type")?.includes("text/html")) {
    const newResp = new Response(resp.body, resp);
    newResp.headers.set("Cache-Control", "no-cache");
    return newResp;
  }
  return resp;
}

export async function handleAssetRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const compatAssetPath = url.pathname === "/public"
    ? "/index.html"
    : url.pathname.startsWith("/public/")
      ? url.pathname.slice("/public".length)
      : "";
  if (compatAssetPath) {
    const compatUrl = new URL(compatAssetPath, url.origin);
    compatUrl.search = url.search;
    const compatReq = new Request(compatUrl.toString(), request);
    const compatResp = await env.ASSETS.fetch(rewriteLegacyClientAssetRequest(compatReq, compatUrl));
    if (compatResp.status !== 404) {
      return prepareAssetResponse(compatResp);
    }
  }
  const assetResp = await env.ASSETS.fetch(rewriteLegacyClientAssetRequest(request, url));
  if (assetResp.status !== 404) {
    return prepareAssetResponse(assetResp);
  }
  const fallbackUrl = new URL("/index.html", url.origin);
  const fallbackReq = new Request(fallbackUrl.toString(), request);
  const fallbackResp = await env.ASSETS.fetch(fallbackReq);
  return prepareAssetResponse(fallbackResp);
}

export const handleAssetRoute = handleAssetRequest;

export const assetRoutes: RouteDef[] = [
  defineRoute({ method: "*", path: "*", domain: "assets", handler: (request, context) => handleAssetRequest(request, context.env), auth: "public", tags: ["assets"] }),
];
