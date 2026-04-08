import { handleLectureAnalyticsReadRoute } from "../services/analytics/read";
import { handleLectureAnalyticsWriteRoute } from "../services/analytics/write";
import { defineRoute, type RouteDef } from "./base";

export const analyticsRoutes: RouteDef[] = [
  defineRoute({ method: "GET", path: "/api/faculty/analytics", domain: "analytics", handler: (request, context) => handleLectureAnalyticsReadRoute(request, context.env), auth: "faculty", tags: ["analytics", "faculty"] }),
  defineRoute({ method: "GET", path: "/api/admin/analytics", domain: "analytics", handler: (request, context) => handleLectureAnalyticsReadRoute(request, context.env), auth: "admin", tags: ["analytics", "admin"] }),
  defineRoute({ method: "POST", path: "/api/admin/analytics", domain: "analytics", handler: (request, context) => handleLectureAnalyticsWriteRoute(request, context.env), auth: "admin", tags: ["analytics", "admin", "write"] }),
];
