import {
  handleAuthLoginRoute,
  handleAuthLogoutRoute,
  handleAuthOidcCallbackRoute,
  handleAuthOidcStartRoute,
  handleAuthProvidersRoute,
  handleAuthSessionRoute,
  handleFacultyLoginRoute,
  handleFacultyLogoutRoute,
  handleFacultySessionRoute,
} from "../services/auth/routes";
import { defineRoute, type RouteDef } from "./base";

export const authRoutes: RouteDef[] = [
  defineRoute({ method: "GET", path: "/api/auth/providers", domain: "auth", handler: (request, context) => handleAuthProvidersRoute(request, context.env), auth: "public", tags: ["auth", "providers"] }),
  defineRoute({ method: "POST", path: "/api/auth/login", domain: "auth", handler: (request, context) => handleAuthLoginRoute(request, context.env), auth: "public", tags: ["auth", "login"] }),
  defineRoute({ method: "GET", path: "/api/auth/session", domain: "auth", handler: (request, context) => handleAuthSessionRoute(request, context.env), auth: "public", tags: ["auth", "session"] }),
  defineRoute({ method: "POST", path: "/api/auth/logout", domain: "auth", handler: (request, context) => handleAuthLogoutRoute(request, context.env), auth: "session", tags: ["auth", "logout"] }),
  defineRoute({ method: "GET", path: "/api/auth/oidc/start", domain: "auth", handler: (request, context) => handleAuthOidcStartRoute(request, context.env), auth: "public", tags: ["auth", "oidc"] }),
  defineRoute({ method: "GET", path: "/api/auth/oidc/callback", domain: "auth", handler: (request, context) => handleAuthOidcCallbackRoute(request, context.env), auth: "public", tags: ["auth", "oidc"] }),
  defineRoute({ method: "POST", path: "/api/faculty/login", domain: "auth", handler: (request, context) => handleFacultyLoginRoute(request, context.env), auth: "public", tags: ["auth", "faculty"] }),
  defineRoute({ method: "GET", path: "/api/faculty/session", domain: "auth", handler: (request, context) => handleFacultySessionRoute(request, context.env), auth: "public", tags: ["auth", "faculty"] }),
  defineRoute({ method: "POST", path: "/api/faculty/logout", domain: "auth", handler: (request, context) => handleFacultyLogoutRoute(request, context.env), auth: "session", tags: ["auth", "faculty"] }),
];
