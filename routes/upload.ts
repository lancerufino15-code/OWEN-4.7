import { handleDownloadRoute, handleFileRoute } from "../services/upload/download";
import { handleSignedUrlRoute } from "../services/upload/signed-url";
import { handleGenerateFileRoute, handleUploadRoute } from "../services/upload/upload";
import { defineRoute, type RouteDef } from "./base";

export const uploadRoutes: RouteDef[] = [
  defineRoute({ method: "GET", path: "/api/r2/signed-url", domain: "upload", handler: (request, context) => handleSignedUrlRoute(request, context.env), auth: "public", tags: ["upload", "signed-url"] }),
  defineRoute({ method: "POST", path: "/api/upload", domain: "upload", handler: (request, context) => handleUploadRoute(request, context.env), auth: "public", tags: ["upload"] }),
  defineRoute({ method: "POST", path: "/api/generate-file", domain: "upload", handler: (request, context) => handleGenerateFileRoute(request, context.env), auth: "public", tags: ["upload", "generate-file"] }),
  defineRoute({ method: "GET", path: "/api/download", domain: "upload", handler: (request, context) => handleDownloadRoute(request, context.env), auth: "public", tags: ["upload", "download"] }),
  defineRoute({ method: "GET", path: "/api/file", domain: "upload", handler: (request, context) => handleFileRoute(request, context.env), auth: "public", tags: ["upload", "file"] }),
];
