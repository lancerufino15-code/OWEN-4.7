import type { Env } from "../../types";
import { jsonNoStore } from "../runtime/http";

export async function handleLibraryQuizInterruptRoute(request: Request, _env: Env): Promise<Response> {
  const requestId = `lib-quiz-interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = await request.json().catch(() => ({}));
  const docId =
    typeof (body as any).docId === "string"
      ? (body as any).docId.trim()
      : typeof (body as any).lectureId === "string"
        ? (body as any).lectureId.trim()
        : "";
  return jsonNoStore({
    ok: true,
    requestId,
    docId,
  });
}
