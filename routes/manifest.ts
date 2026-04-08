import { analyticsRoutes } from "./analytics";
import { ankiRoutes } from "./anki";
import { assetRoutes } from "./assets";
import { authRoutes } from "./auth";
import { chatRoutes } from "./chat";
import { libraryRoutes } from "./library";
import { pdfRoutes } from "./pdf";
import { presenceRoutes } from "./presence";
import { quizRoutes } from "./quiz";
import { studyGuideRoutes } from "./study-guide";
import { uploadRoutes } from "./upload";
import type { RouteDef, RouteParams } from "./base";

interface CompiledRouteDef {
  route: RouteDef;
  matcher: RegExp;
  paramNames: string[];
}

export const ROUTE_MANIFEST: RouteDef[] = [
  ...authRoutes,
  ...analyticsRoutes,
  ...presenceRoutes,
  ...libraryRoutes,
  ...quizRoutes,
  ...studyGuideRoutes,
  ...ankiRoutes,
  ...chatRoutes,
  ...pdfRoutes,
  ...uploadRoutes,
  ...assetRoutes,
];

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileRoute(route: RouteDef): CompiledRouteDef {
  if (route.path === "*") {
    return { route, matcher: /^.*$/, paramNames: [] };
  }

  const paramNames: string[] = [];
  const pattern = route.path
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      if (!segment.startsWith(":")) return escapeRegex(segment);
      const paramName = segment.slice(1);
      paramNames.push(paramName);
      return "([^/]+)";
    })
    .join("/");

  return {
    route,
    matcher: new RegExp(`^${pattern}$`),
    paramNames,
  };
}

const compiledManifest = ROUTE_MANIFEST.map(compileRoute);

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export function getRouteManifest(): RouteDef[] {
  return ROUTE_MANIFEST;
}

export function matchRoute(request: Request): { route: RouteDef; params: RouteParams } | null {
  const pathname = new URL(request.url).pathname;
  const apiOnly = isApiPath(pathname);

  for (const entry of compiledManifest) {
    const routeIsAsset = entry.route.domain === "assets";
    if (apiOnly && routeIsAsset) continue;
    if (!apiOnly && !routeIsAsset) continue;
    if (entry.route.method !== "*" && entry.route.method !== request.method) continue;

    const match = pathname.match(entry.matcher);
    if (!match) continue;

    const params = entry.paramNames.reduce<RouteParams>((acc, name, index) => {
      acc[name] = decodeURIComponent(match[index + 1] || "");
      return acc;
    }, {});

    return { route: entry.route, params };
  }

  return null;
}
