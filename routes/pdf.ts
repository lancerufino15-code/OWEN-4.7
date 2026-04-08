import {
  handleAskDocRoute,
  handleAskFileRoute,
  handleExtractRoute,
  handlePdfIngestRoute,
} from "../services/pdf/extract";
import { handleOcrFinalizeRoute, handleOcrPageRoute } from "../services/pdf/ocr";
import { defineRoute, type RouteDef } from "./base";

export const pdfRoutes: RouteDef[] = [
  defineRoute({ method: "POST", path: "/api/pdf-ingest", domain: "pdf", handler: (request, context) => handlePdfIngestRoute(request, context.env), auth: "public", tags: ["pdf", "ingest"] }),
  defineRoute({ method: "POST", path: "/api/ask-file", domain: "pdf", handler: (request, context) => handleAskFileRoute(request, context.env), auth: "public", tags: ["pdf", "ask-file"] }),
  defineRoute({ method: "POST", path: "/api/ask-doc", domain: "pdf", handler: (request, context) => handleAskDocRoute(request, context.env), auth: "public", tags: ["pdf", "ask-doc"] }),
  defineRoute({ method: "POST", path: "/api/ocr-page", domain: "pdf", handler: (request, context) => handleOcrPageRoute(request, context.env), auth: "public", tags: ["pdf", "ocr"] }),
  defineRoute({ method: "POST", path: "/api/ocr-finalize", domain: "pdf", handler: (request, context) => handleOcrFinalizeRoute(request, context.env), auth: "public", tags: ["pdf", "ocr"] }),
  defineRoute({ method: "POST", path: "/api/extract", domain: "pdf", handler: (request, context) => handleExtractRoute(request, context.env), auth: "public", tags: ["pdf", "extract"] }),
];
