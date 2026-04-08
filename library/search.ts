import { handleApiRequest } from "../runtime/legacy-core";
import type { Env } from "../../types";

export function handleLibrarySearchRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryAskRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryAskContinueRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryListRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryCourseRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryCategoryRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}

export function handleLibraryLectureRoute(request: Request, env: Env): Promise<Response> {
  return handleApiRequest(request, env);
}
