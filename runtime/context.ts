import { getAppConfig, type AppConfig } from "../app/config";
import { buildAuditActor, getRequestId, writeAuditEvent, type AuditActor, type AuditEvent } from "../observability/audit";
import { recordMetricEvent, type OwenMetricEvent } from "../observability/metrics";
import { getRuntimeFeatures } from "../services/runtime/config/runtime-features";
import type { Env } from "../types";
import type { AuthSessionRecord } from "../auth/session";

export interface RuntimeStorageBindings {
  buckets: {
    primary: R2Bucket;
    ingest: R2Bucket;
    notes: R2Bucket;
    uploads: R2Bucket;
    analytics: R2Bucket;
    test: R2Bucket;
  };
  kv: {
    docs?: KVNamespace;
    cache?: KVNamespace;
    diagnostics?: KVNamespace;
  };
  durableObjects: {
    presence: DurableObjectNamespace;
  };
}

export interface RuntimeCapabilityFlags {
  hasAiBinding: boolean;
  hasBrowserBinding: boolean;
  devAuthEnabled: boolean;
  oidcConfigured: boolean;
  uaoEnabled: boolean;
}

export interface RuntimeObservability {
  auditActor?: AuditActor;
  writeAudit: (event: Omit<AuditEvent, "requestId" | "path" | "method" | "ip" | "ts">) => Promise<void>;
  writeMetric: (event: Omit<OwenMetricEvent, "ts">) => Promise<void>;
}

export interface RuntimeContext {
  env: Env;
  config: AppConfig;
  requestId: string;
  requestUrl: URL;
  auditActor?: AuditActor;
  observability: RuntimeObservability;
  capabilities: RuntimeCapabilityFlags;
  storage: RuntimeStorageBindings;
}

function buildRuntimeStorage(env: Env): RuntimeStorageBindings {
  return {
    buckets: {
      primary: env.OWEN_BUCKET,
      ingest: env.OWEN_INGEST,
      notes: env.OWEN_NOTES,
      uploads: env.OWEN_UPLOADS,
      analytics: env.OWEN_ANALYTICS,
      test: env.OWEN_TEST,
    },
    kv: {
      docs: env.DOCS_KV,
      cache: env.OWEN_DOC_CACHE,
      diagnostics: env.OWEN_DIAG_KV,
    },
    durableObjects: {
      presence: env.PRESENCE_ROOM,
    },
  };
}

function buildRuntimeCapabilities(env: Env, config: AppConfig): RuntimeCapabilityFlags {
  const features = getRuntimeFeatures(env);
  return {
    hasAiBinding: Boolean(env.AI),
    hasBrowserBinding: Boolean(env.BROWSER),
    devAuthEnabled: config.auth.dev.enabled,
    oidcConfigured: config.auth.oidc.configured,
    uaoEnabled: features.uao.enabled,
  };
}

export function createRuntimeContext(
  request: Request,
  env: Env,
  opts: { requestId?: string; session?: AuthSessionRecord | null } = {},
): RuntimeContext {
  const requestId = opts.requestId || getRequestId(request);
  const requestUrl = new URL(request.url);
  const config = getAppConfig(env, request);
  const auditActor = buildAuditActor(opts.session);

  return {
    env,
    config,
    requestId,
    requestUrl,
    auditActor,
    observability: {
      auditActor,
      writeAudit: (event) => writeAuditEvent(env, request, requestId, event),
      writeMetric: (event) => recordMetricEvent(env, event),
    },
    capabilities: buildRuntimeCapabilities(env, config),
    storage: buildRuntimeStorage(env),
  };
}

export function withRuntimeAuditActor(context: RuntimeContext, session: AuthSessionRecord | null): RuntimeContext {
  const auditActor = buildAuditActor(session);
  return {
    ...context,
    auditActor,
    observability: {
      ...context.observability,
      auditActor,
    },
  };
}
