import { handleTrafficPingRoute, handleTrafficSnapshotRoute } from "../services/presence/traffic";
import { defineRoute, type RouteDef } from "./base";

export const presenceRoutes: RouteDef[] = [
  defineRoute({ method: "POST", path: "/api/presence", domain: "presence", handler: (request, context) => handleTrafficPingRoute(request, context.env), auth: "public", tags: ["presence"] }),
  defineRoute({ method: "GET", path: "/api/presence", domain: "presence", handler: (request, context) => handleTrafficSnapshotRoute(request, context.env), auth: "public", tags: ["presence", "snapshot"] }),
  defineRoute({ method: "GET", path: "/api/presence/snapshot", domain: "presence", handler: (request, context) => handleTrafficSnapshotRoute(request, context.env), auth: "public", tags: ["presence", "snapshot"] }),
  defineRoute({ method: "POST", path: "/api/traffic/ping", domain: "presence", handler: (request, context) => handleTrafficPingRoute(request, context.env), auth: "public", tags: ["traffic"] }),
  defineRoute({ method: "GET", path: "/api/traffic/snapshot", domain: "presence", handler: (request, context) => handleTrafficSnapshotRoute(request, context.env), auth: "public", tags: ["traffic", "snapshot"] }),
];
