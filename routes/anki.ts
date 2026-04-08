import { handleAnkiDownloadRoute } from "../services/anki/download";
import { handleAnkiGenerateRoute } from "../services/anki/generation";
import { handleAnkiPublishRoute } from "../services/anki/publish";
import { defineRoute, type RouteDef } from "./base";

export const ankiRoutes: RouteDef[] = [
  defineRoute({ method: "POST", path: "/api/anki/generate", domain: "anki", handler: (request, context) => handleAnkiGenerateRoute(request, context.env), auth: "faculty", tags: ["anki", "generate"] }),
  defineRoute({ method: "POST", path: "/api/anki/publish", domain: "anki", handler: (request, context) => handleAnkiPublishRoute(request, context.env), auth: "faculty", tags: ["anki", "publish"] }),
  defineRoute({ method: "POST", path: "/api/publish/anki", domain: "anki", handler: (request, context) => handleAnkiPublishRoute(request, context.env), auth: "faculty", tags: ["anki", "publish", "legacy"] }),
  defineRoute({ method: "GET", path: "/api/anki/download", domain: "anki", handler: (request, context) => handleAnkiDownloadRoute(request, context.env), auth: "public", tags: ["anki", "download"] }),
];
