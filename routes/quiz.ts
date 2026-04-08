import { handleLibraryQbankSaveFromQuizRoute, handleLibraryQbankUploadRoute } from "../services/library/qbank";
import { handleLibraryGeminiQuizRoute } from "../services/quiz/gemini";
import { handleLibraryQuizRoute } from "../services/quiz/generation";
import { handleLibraryQuizInterruptRoute } from "../services/quiz/interrupt";
import { defineRoute, type RouteDef } from "./base";

export const quizRoutes: RouteDef[] = [
  defineRoute({ method: "POST", path: "/api/library/gemini-quiz", domain: "quiz", handler: (request, context) => handleLibraryGeminiQuizRoute(request, context.env), auth: "public", tags: ["quiz", "gemini"] }),
  defineRoute({ method: "POST", path: "/api/library/quiz", domain: "quiz", handler: (request, context) => handleLibraryQuizRoute(request, context.env), auth: "public", tags: ["quiz"] }),
  defineRoute({ method: "POST", path: "/api/library/quiz/interrupt", domain: "quiz", handler: (request, context) => handleLibraryQuizInterruptRoute(request, context.env), auth: "public", tags: ["quiz", "interrupt"] }),
  defineRoute({ method: "POST", path: "/api/library/qbank/save-from-quiz", domain: "quiz", handler: (request, context) => handleLibraryQbankSaveFromQuizRoute(request, context.env), auth: "faculty", tags: ["quiz", "qbank", "write"] }),
  defineRoute({ method: "POST", path: "/api/library/qbank/upload", domain: "quiz", handler: (request, context) => handleLibraryQbankUploadRoute(request, context.env), auth: "faculty", tags: ["quiz", "qbank", "upload"] }),
];
