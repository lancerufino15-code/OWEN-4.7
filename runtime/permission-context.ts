import { AuthorizationPolicy, type AuthorizationDecision, type AuthorizationResource, type PolicyAction } from "../auth/policy";
import type { AuthSessionRecord } from "../auth/session";

export type AgentCapability = "files" | "web_search" | "none";
export type RouteAuthRequirement = "public" | "session" | "faculty" | "admin";

export interface PermissionContext {
  principal: AuthSessionRecord | null;
  agentCapabilities: ReadonlySet<AgentCapability>;
  routeRequirement: RouteAuthRequirement;
  isAuthenticated: boolean;
  isFaculty: boolean;
  isAdmin: boolean;
  allowsRoute: (requirement?: RouteAuthRequirement) => boolean;
  allowsAction: (action: PolicyAction, resource?: AuthorizationResource) => AuthorizationDecision;
}

export function createPermissionContext(
  principal: AuthSessionRecord | null,
  opts: {
    agentCapabilities?: Iterable<AgentCapability>;
    routeRequirement?: RouteAuthRequirement;
  } = {},
): PermissionContext {
  const capabilities = new Set<AgentCapability>(opts.agentCapabilities || []);
  const routeRequirement = opts.routeRequirement || "public";
  const isAuthenticated = Boolean(principal);
  const isFaculty = principal?.role === "faculty" || principal?.role === "admin";
  const isAdmin = principal?.role === "admin";

  return {
    principal,
    agentCapabilities: capabilities,
    routeRequirement,
    isAuthenticated,
    isFaculty,
    isAdmin,
    allowsRoute(requirement = routeRequirement) {
      if (requirement === "public") return true;
      if (requirement === "session") return isAuthenticated;
      if (requirement === "faculty") return isFaculty;
      if (requirement === "admin") return isAdmin;
      return false;
    },
    allowsAction(action, resource = {}) {
      return AuthorizationPolicy.canAccess(principal, action, resource);
    },
  };
}
