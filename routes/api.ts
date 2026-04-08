import { handleLectureAnalyticsRead, handleAdminAnalyticsWrite } from "../services/analytics/http";
import { handleAnkiDownloadRoute } from "../services/anki/download";
import { handleAnkiGenerateRoute } from "../services/anki/generation";
import { handleAnkiPublishRoute } from "../services/anki/publish";
import {
  handleAuthLogin,
  handleAuthLogout,
  handleAuthOidcCallback,
  handleAuthOidcStart,
  handleAuthProviders,
  handleAuthSession,
  handleFacultyLogin,
  handleFacultyLogout,
  handleFacultySession,
} from "../services/auth/http";
import { handleChatContinueRoute, handleChatRoute } from "../services/chat/agent-chat";
import {
  handleConversationCollectionRoute,
  handleConversationItemRoute,
  handleMetaTagsRequest,
} from "../services/conversations/http";
import { handleLibraryDownloadRoute } from "../services/library/download";
import {
  handleLibraryBatchIndexRoute,
  handleLibraryBatchIngestRoute,
  handleLibraryIngestRoute,
  handleLibraryTxtUploadRoute,
} from "../services/library/ingest";
import { handleLibraryQbankSaveFromQuizRoute, handleLibraryQbankUploadRoute } from "../services/library/qbank";
import {
  handleLibraryAskContinueRoute,
  handleLibraryAskRoute,
  handleLibraryCategoryRoute,
  handleLibraryCourseRoute,
  handleLibraryLectureRoute,
  handleLibraryListRoute,
  handleLibrarySearchRoute,
} from "../services/library/search";
import { handleAskDocRoute, handleAskFileRoute, handleExtractRoute, handlePdfIngestRoute } from "../services/pdf/extract";
import { handleOcrFinalizeRoute, handleOcrPageRoute } from "../services/pdf/ocr";
import { handleTrafficPing, handleTrafficSnapshot } from "../services/presence/http";
import { handleLibraryGeminiQuizRoute } from "../services/quiz/gemini";
import { handleLibraryQuizRoute } from "../services/quiz/generation";
import { handleLibraryQuizInterruptRoute } from "../services/quiz/interrupt";
import { jsonNoStore, RUNTIME_CORS_HEADERS } from "../services/runtime/http";
import { ALLOWED_MODELS } from "../services/runtime/model-selection";
import {
  handleRuntimeSessionResumeRoute,
  handleRuntimeSessionRoute,
} from "../services/runtime/session";
import {
  handleAdminCostExport,
  handleAdminRuntimeConfig,
  handleFacultyCostArtifacts,
  handleFacultyCostByModel,
  handleFacultyCostByWorkflow,
  handleFacultyCostExport,
  handleFacultyCostLive,
  handleFacultyCostSessions,
  handleFacultyCostSummary,
  handleFacultyCostTimeseries,
} from "../services/runtime/usage/api";
import {
  handleMachineDownloadRoute,
  handleMachineGenerateStudyGuideRoute,
  handlePublishStudyGuideRoute,
  handleRetrieveStudyGuideRoute,
  handleStudyGuideAssetRoute,
} from "../services/study-guide/render";
import { handleDownloadRoute, handleFileRoute } from "../services/upload/download";
import { handleSignedUrlRoute } from "../services/upload/signed-url";
import { handleGenerateFileRoute, handleUploadRoute } from "../services/upload/upload";
import type { Env } from "../types";

function methodNotAllowed() {
  return new Response("Method not allowed", { status: 405, headers: RUNTIME_CORS_HEADERS });
}

export async function handleApiRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/models" && req.method === "GET") {
    return jsonNoStore({ models: ALLOWED_MODELS });
  }

  if (url.pathname === "/api/meta-tags") {
    return handleMetaTagsRequest(req, env);
  }

  if (url.pathname === "/api/conversations") {
    if (req.method === "GET" || req.method === "POST" || req.method === "DELETE") {
      return handleConversationCollectionRoute(req, env);
    }
    return methodNotAllowed();
  }

  if (url.pathname.startsWith("/api/conversations/")) {
    if (req.method === "GET" || req.method === "DELETE") {
      return handleConversationItemRoute(req, env);
    }
    return methodNotAllowed();
  }

  if (url.pathname.startsWith("/api/runtime/session/")) {
    if (url.pathname.endsWith("/resume") && req.method === "POST") return handleRuntimeSessionResumeRoute(req, env);
    if (req.method === "GET") return handleRuntimeSessionRoute(req, env);
    return methodNotAllowed();
  }

  if (url.pathname === "/api/faculty/analytics" && req.method === "GET") {
    return handleLectureAnalyticsRead(req, env);
  }

  if (url.pathname === "/api/faculty/costs/summary" && req.method === "GET") return handleFacultyCostSummary(req, env);
  if (url.pathname === "/api/faculty/costs/timeseries" && req.method === "GET") return handleFacultyCostTimeseries(req, env);
  if (url.pathname === "/api/faculty/costs/by-model" && req.method === "GET") return handleFacultyCostByModel(req, env);
  if (url.pathname === "/api/faculty/costs/by-workflow" && req.method === "GET") return handleFacultyCostByWorkflow(req, env);
  if (url.pathname === "/api/faculty/costs/sessions" && req.method === "GET") return handleFacultyCostSessions(req, env);
  if (url.pathname === "/api/faculty/costs/artifacts" && req.method === "GET") return handleFacultyCostArtifacts(req, env);
  if (url.pathname === "/api/faculty/costs/live" && req.method === "GET") return handleFacultyCostLive(req, env);
  if (url.pathname === "/api/faculty/costs/export" && req.method === "GET") return handleFacultyCostExport(req, env);

  if (url.pathname === "/api/admin/analytics") {
    if (req.method === "GET") return handleLectureAnalyticsRead(req, env);
    if (req.method === "POST") return handleAdminAnalyticsWrite(req, env);
    return methodNotAllowed();
  }

  if (url.pathname === "/api/admin/costs/export" && req.method === "GET") return handleAdminCostExport(req, env);
  if (url.pathname === "/api/admin/runtime/config" && req.method === "GET") return handleAdminRuntimeConfig(req, env);

  if (url.pathname === "/api/presence" && req.method === "POST") {
    return handleTrafficPing(req, env);
  }

  if ((url.pathname === "/api/presence" || url.pathname === "/api/presence/snapshot") && req.method === "GET") {
    return handleTrafficSnapshot(req, env);
  }

  if (url.pathname === "/api/traffic/ping" && req.method === "POST") {
    return handleTrafficPing(req, env);
  }

  if (url.pathname === "/api/traffic/snapshot" && req.method === "GET") {
    return handleTrafficSnapshot(req, env);
  }

  if (url.pathname === "/api/auth/providers" && req.method === "GET") return handleAuthProviders(req, env);
  if (url.pathname === "/api/auth/login" && req.method === "POST") return handleAuthLogin(req, env);
  if (url.pathname === "/api/auth/session" && req.method === "GET") return handleAuthSession(req, env);
  if (url.pathname === "/api/auth/logout" && req.method === "POST") return handleAuthLogout(req, env);
  if (url.pathname === "/api/auth/oidc/start" && req.method === "GET") return handleAuthOidcStart(req, env);
  if (url.pathname === "/api/auth/oidc/callback" && req.method === "GET") return handleAuthOidcCallback(req, env);
  if (url.pathname === "/api/faculty/login" && req.method === "POST") return handleFacultyLogin(req, env);
  if (url.pathname === "/api/faculty/session" && req.method === "GET") return handleFacultySession(req, env);
  if (url.pathname === "/api/faculty/logout" && req.method === "POST") return handleFacultyLogout(req, env);

  if (url.pathname === "/api/library/search" && req.method === "GET") return handleLibrarySearchRoute(req, env);
  if (url.pathname === "/api/library/categories" && (req.method === "GET" || req.method === "POST")) return handleLibraryCategoryRoute(req, env);
  if (url.pathname === "/api/library/courses" && (req.method === "GET" || req.method === "POST")) return handleLibraryCourseRoute(req, env);
  if (url.pathname === "/api/library/course" && (req.method === "PATCH" || req.method === "DELETE")) return handleLibraryCourseRoute(req, env);
  if (url.pathname === "/api/library/ingest" && req.method === "POST") return handleLibraryIngestRoute(req, env);
  if (url.pathname === "/api/library/ask" && req.method === "POST") return handleLibraryAskRoute(req, env);
  if (url.pathname === "/api/library/ask-continue" && req.method === "POST") return handleLibraryAskContinueRoute(req, env);
  if (url.pathname === "/api/library/gemini-quiz" && req.method === "POST") return handleLibraryGeminiQuizRoute(req, env);
  if (url.pathname === "/api/library/quiz" && req.method === "POST") return handleLibraryQuizRoute(req, env);
  if (url.pathname === "/api/library/quiz/interrupt" && req.method === "POST") return handleLibraryQuizInterruptRoute(req, env);
  if (url.pathname === "/api/library/qbank/save-from-quiz" && req.method === "POST") return handleLibraryQbankSaveFromQuizRoute(req, env);
  if (url.pathname === "/api/library/qbank/upload" && req.method === "POST") return handleLibraryQbankUploadRoute(req, env);
  if (url.pathname === "/api/library/txt/upload" && req.method === "POST") return handleLibraryTxtUploadRoute(req, env);
  if (url.pathname === "/api/library/list" && req.method === "GET") return handleLibraryListRoute(req, env);
  if (url.pathname === "/api/library/lecture" && (req.method === "PATCH" || req.method === "DELETE")) return handleLibraryLectureRoute(req, env);
  if (url.pathname === "/api/library/download" && req.method === "GET") return handleLibraryDownloadRoute(req, env);
  if (url.pathname === "/api/library/batch-index" && req.method === "POST") return handleLibraryBatchIndexRoute(req, env);
  if (url.pathname === "/api/library/batch-ingest" && req.method === "POST") return handleLibraryBatchIngestRoute(req, env);

  if (url.pathname === "/api/machine/lecture-to-txt" && req.method === "POST") return handleLibraryTxtUploadRoute(req, env);
  if (url.pathname === "/api/machine/generate-study-guide" && req.method === "POST") return handleMachineGenerateStudyGuideRoute(req, env);
  if (url.pathname === "/api/machine/download" && req.method === "GET") return handleMachineDownloadRoute(req, env);

  if ((url.pathname === "/api/study-guides/publish" || url.pathname === "/api/publish/study-guide") && req.method === "POST") {
    return handlePublishStudyGuideRoute(req, env);
  }
  if (url.pathname === "/api/retrieve/study-guide" && req.method === "GET") return handleRetrieveStudyGuideRoute(req, env);
  if (url.pathname === "/api/study-guides/asset" && req.method === "GET") return handleStudyGuideAssetRoute(req, env);

  if (url.pathname === "/api/anki/generate" && req.method === "POST") return handleAnkiGenerateRoute(req, env);
  if ((url.pathname === "/api/anki/publish" || url.pathname === "/api/publish/anki") && req.method === "POST") {
    return handleAnkiPublishRoute(req, env);
  }
  if (url.pathname === "/api/anki/download" && req.method === "GET") return handleAnkiDownloadRoute(req, env);

  if (url.pathname === "/api/r2/signed-url" && req.method === "GET") return handleSignedUrlRoute(req, env);
  if (url.pathname === "/api/upload" && req.method === "POST") return handleUploadRoute(req, env);
  if (url.pathname === "/api/chat/continue" && req.method === "POST") return handleChatContinueRoute(req, env);
  if (url.pathname === "/api/chat" && req.method === "POST") return handleChatRoute(req, env);
  if (url.pathname === "/api/pdf-ingest" && req.method === "POST") return handlePdfIngestRoute(req, env);
  if (url.pathname === "/api/ask-file" && req.method === "POST") return handleAskFileRoute(req, env);
  if (url.pathname === "/api/ask-doc" && req.method === "POST") return handleAskDocRoute(req, env);
  if (url.pathname === "/api/ocr-page" && req.method === "POST") return handleOcrPageRoute(req, env);
  if (url.pathname === "/api/ocr-finalize" && req.method === "POST") return handleOcrFinalizeRoute(req, env);
  if (url.pathname === "/api/generate-file" && req.method === "POST") return handleGenerateFileRoute(req, env);
  if (url.pathname === "/api/download" && req.method === "GET") return handleDownloadRoute(req, env);
  if (url.pathname === "/api/extract" && req.method === "POST") return handleExtractRoute(req, env);
  if (url.pathname === "/api/file" && req.method === "GET") return handleFileRoute(req, env);

  return new Response("Not found", { status: 404, headers: RUNTIME_CORS_HEADERS });
}
