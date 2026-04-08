import {
  handleLibraryAskContinueRoute,
  handleLibraryAskRoute,
  handleLibraryCategoryRoute,
  handleLibraryCourseRoute,
  handleLibraryLectureRoute,
  handleLibraryListRoute,
  handleLibrarySearchRoute,
} from "../services/library/search";
import {
  handleLibraryBatchIndexRoute,
  handleLibraryBatchIngestRoute,
  handleLibraryIngestRoute,
  handleLibraryTxtUploadRoute,
} from "../services/library/ingest";
import { handleLibraryDownloadRoute } from "../services/library/download";
import { defineRoute, type RouteDef } from "./base";

export const libraryRoutes: RouteDef[] = [
  defineRoute({ method: "GET", path: "/api/library/search", domain: "library", handler: (request, context) => handleLibrarySearchRoute(request, context.env), auth: "public", tags: ["library", "search"] }),
  defineRoute({ method: "GET", path: "/api/library/courses", domain: "library", handler: (request, context) => handleLibraryCourseRoute(request, context.env), auth: "public", tags: ["library", "courses"] }),
  defineRoute({ method: "GET", path: "/api/library/categories", domain: "library", handler: (request, context) => handleLibraryCategoryRoute(request, context.env), auth: "public", tags: ["library", "categories"] }),
  defineRoute({ method: "POST", path: "/api/library/categories", domain: "library", handler: (request, context) => handleLibraryCategoryRoute(request, context.env), auth: "faculty", tags: ["library", "categories", "write"] }),
  defineRoute({ method: "POST", path: "/api/library/courses", domain: "library", handler: (request, context) => handleLibraryCourseRoute(request, context.env), auth: "faculty", tags: ["library", "courses", "write"] }),
  defineRoute({ method: "PATCH", path: "/api/library/course", domain: "library", handler: (request, context) => handleLibraryCourseRoute(request, context.env), auth: "faculty", tags: ["library", "course", "write"] }),
  defineRoute({ method: "DELETE", path: "/api/library/course", domain: "library", handler: (request, context) => handleLibraryCourseRoute(request, context.env), auth: "faculty", tags: ["library", "course", "delete"] }),
  defineRoute({ method: "POST", path: "/api/library/ingest", domain: "library", handler: (request, context) => handleLibraryIngestRoute(request, context.env), auth: "faculty", tags: ["library", "ingest"] }),
  defineRoute({ method: "POST", path: "/api/library/ask", domain: "library", handler: (request, context) => handleLibraryAskRoute(request, context.env), auth: "public", tags: ["library", "ask"] }),
  defineRoute({ method: "POST", path: "/api/library/ask-continue", domain: "library", handler: (request, context) => handleLibraryAskContinueRoute(request, context.env), auth: "public", tags: ["library", "ask", "continue"] }),
  defineRoute({ method: "POST", path: "/api/library/txt/upload", domain: "library", handler: (request, context) => handleLibraryTxtUploadRoute(request, context.env), auth: "faculty", tags: ["library", "txt", "upload"] }),
  defineRoute({ method: "GET", path: "/api/library/list", domain: "library", handler: (request, context) => handleLibraryListRoute(request, context.env), auth: "public", tags: ["library", "list"] }),
  defineRoute({ method: "PATCH", path: "/api/library/lecture", domain: "library", handler: (request, context) => handleLibraryLectureRoute(request, context.env), auth: "faculty", tags: ["library", "lecture", "write"] }),
  defineRoute({ method: "GET", path: "/api/library/download", domain: "library", handler: (request, context) => handleLibraryDownloadRoute(request, context.env), auth: "faculty", tags: ["library", "download"] }),
  defineRoute({ method: "DELETE", path: "/api/library/lecture", domain: "library", handler: (request, context) => handleLibraryLectureRoute(request, context.env), auth: "faculty", tags: ["library", "lecture", "delete"] }),
  defineRoute({ method: "POST", path: "/api/library/batch-index", domain: "library", handler: (request, context) => handleLibraryBatchIndexRoute(request, context.env), auth: "faculty", tags: ["library", "batch"] }),
  defineRoute({ method: "POST", path: "/api/library/batch-ingest", domain: "library", handler: (request, context) => handleLibraryBatchIngestRoute(request, context.env), auth: "faculty", tags: ["library", "batch"] }),
  defineRoute({ method: "POST", path: "/api/machine/lecture-to-txt", domain: "library", handler: (request, context) => handleLibraryTxtUploadRoute(request, context.env), auth: "faculty", tags: ["library", "machine-txt"] }),
];
