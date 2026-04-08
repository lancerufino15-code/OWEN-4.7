import type { Env } from "../types";
import { generateOpaqueId } from "../utils/ids";

export type OwenMetricName =
  | "artifact_generated"
  | "artifact_published"
  | "artifact_opened"
  | "runtime_capability_denied"
  | "usage_event";
export type OwenArtifactType = "anki" | "study_guide";

export interface OwenMetricEvent {
  name: OwenMetricName;
  ts: string;
  requestId: string;
  artifactType?: OwenArtifactType;
  artifactCode?: string;
  institutionId?: string;
  courseId?: string;
  lectureId?: string;
  userId?: string;
  role?: string;
  metadata?: Record<string, unknown>;
}

function getMetricsKv(env: Env): KVNamespace | undefined {
  return env.OWEN_DIAG_KV || env.DOCS_KV;
}

export async function recordMetricEvent(
  env: Env,
  event: Omit<OwenMetricEvent, "ts">,
): Promise<void> {
  const payload: OwenMetricEvent = {
    ...event,
    ts: new Date().toISOString(),
  };
  console.info("[OWEN_METRIC]", JSON.stringify(payload));
  const kv = getMetricsKv(env);
  if (!kv) return;
  const key = `metric:${payload.ts}:${payload.name}:${generateOpaqueId("metric")}`;
  await kv.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 90 });
}
