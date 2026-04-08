import type { RouteAuthRequirement } from "../runtime/permission-context";
import type { RuntimeContext } from "../runtime/context";

export type RouteDomain =
  | "auth"
  | "analytics"
  | "presence"
  | "library"
  | "quiz"
  | "study-guide"
  | "anki"
  | "chat"
  | "pdf"
  | "upload"
  | "assets";

export type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "HEAD" | "*";
export type RouteParams = Record<string, string>;
export type RouteHandler = (request: Request, context: RuntimeContext, params: RouteParams) => Promise<Response>;

export interface RouteDef {
  method: RouteMethod;
  path: string;
  domain: RouteDomain;
  handler: RouteHandler;
  auth?: RouteAuthRequirement;
  tags?: string[];
}

export function defineRoute(route: RouteDef): RouteDef {
  return route;
}
