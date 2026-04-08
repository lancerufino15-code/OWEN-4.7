import {
  handleMachineDownloadRoute,
  handleMachineGenerateStudyGuideRoute,
  handlePublishStudyGuideRoute,
  handleRetrieveStudyGuideRoute,
  handleStudyGuideAssetRoute,
} from "../services/study-guide/render";
import { defineRoute, type RouteDef } from "./base";

export const studyGuideRoutes: RouteDef[] = [
  defineRoute({ method: "POST", path: "/api/machine/generate-study-guide", domain: "study-guide", handler: (request, context) => handleMachineGenerateStudyGuideRoute(request, context.env), auth: "faculty", tags: ["study-guide", "generate"] }),
  defineRoute({ method: "GET", path: "/api/machine/download", domain: "study-guide", handler: (request, context) => handleMachineDownloadRoute(request, context.env), auth: "faculty", tags: ["study-guide", "download"] }),
  defineRoute({ method: "POST", path: "/api/study-guides/publish", domain: "study-guide", handler: (request, context) => handlePublishStudyGuideRoute(request, context.env), auth: "faculty", tags: ["study-guide", "publish"] }),
  defineRoute({ method: "POST", path: "/api/publish/study-guide", domain: "study-guide", handler: (request, context) => handlePublishStudyGuideRoute(request, context.env), auth: "faculty", tags: ["study-guide", "publish", "legacy"] }),
  defineRoute({ method: "GET", path: "/api/retrieve/study-guide", domain: "study-guide", handler: (request, context) => handleRetrieveStudyGuideRoute(request, context.env), auth: "public", tags: ["study-guide", "retrieve"] }),
  defineRoute({ method: "GET", path: "/api/study-guides/asset", domain: "study-guide", handler: (request, context) => handleStudyGuideAssetRoute(request, context.env), auth: "public", tags: ["study-guide", "asset"] }),
];
