/**
 * Cloudflare Worker environment bindings for OWEN.
 *
 * Used by: `src/index.ts` and analytics/diagnostics helpers to access secrets, KV,
 * and R2 buckets.
 *
 * Key exports:
 * - `Env`: binding contract for Worker runtime configuration.
 *
 * Assumptions:
 * - Secrets are provided via Wrangler (`wrangler secret put`).
 * - Optional flags are passed as strings ("1", "true", etc.) and parsed by callers.
 */
export interface Env {
  /** Static asset binding for the worker (served from /public). */
  ASSETS: Fetcher;
  /** Optional browser rendering binding retained for backwards-compatible deploy config. */
  BROWSER?: Fetcher;
  /** Workers AI binding for schema-constrained model calls. */
  AI?: Ai;
  /** Deployment environment hint used for config hardening. */
  APP_ENV?: string;
  /** Alias deployment environment hint used by some local setups. */
  ENVIRONMENT?: string;
  /** Public base URL used for redirects and absolute links when required. */
  APP_BASE_URL?: string;
  /** Institution slug used for scoping resources when records omit one. */
  DEFAULT_INSTITUTION_ID?: string;
  /** Institution label exposed in docs and trust metadata. */
  DEFAULT_INSTITUTION_NAME?: string;
  /** Canonical text model id for general Responses/Chat calls. */
  DEFAULT_TEXT_MODEL: string;
  /** Legacy/default model id retained for existing deploy-time variables. */
  DEFAULT_MODEL?: string;
  /** Comma-separated browser origins allowed to call the API cross-origin. */
  ALLOWED_ORIGINS?: string;
  /** OpenAI API key used for Responses/Chat calls. */
  OPENAI_API_KEY: string;
  /** Base URL for OpenAI-compatible REST API. */
  OPENAI_API_BASE: string;
  /** Google Gemini API key used only by the Worker for quiz generation. */
  GEMINI_API_KEY?: string;
  /** Optional base URL override for Gemini REST calls. */
  GEMINI_API_BASE?: string;
  /** Optional model override for Gemini lecture quiz generation. */
  GEMINI_QUIZ_MODEL?: string;
  /** Optional timeout override for Gemini quiz generation (milliseconds). */
  GEMINI_QUIZ_TIMEOUT_MS?: string;
  /** Optional max output token override for Gemini quiz generation. */
  GEMINI_QUIZ_MAX_OUTPUT_TOKENS?: string;
  /** Optional thinking-level hint retained for existing deploy-time config. */
  GEMINI_QUIZ_THINKING_LEVEL?: string;
  /** Optional override for quiz AI timeout (milliseconds). */
  QUIZ_AI_TIMEOUT_MS?: string;
  /** If set, strips sampling params for stricter deterministic payloads. */
  OWEN_STRIP_SAMPLING_PARAMS?: string;
  /** Enables extra diagnostics and debug logging when truthy. */
  OWEN_DEBUG?: string;
  /** When set, preserves raw study guide JSON for inspection. */
  DEBUG_STUDY_GUIDE_JSON?: string;
  /** Session TTL for authenticated sessions (seconds). */
  AUTH_SESSION_TTL_SECONDS?: string;
  /** Session TTL for browser-scoped anonymous conversation sessions (seconds). */
  BROWSER_SESSION_TTL_SECONDS?: string;
  /** Enables development auth when the request is local or explicitly preview-safe. */
  DEV_AUTH_ENABLED?: string;
  /** Shared secret required by the development auth provider. */
  DEV_AUTH_SECRET?: string;
  /** Enables the explicit dev-only auth provider outside production. */
  AUTH_DEV_MODE?: string;
  /** Shared secret required by the dev auth provider. */
  AUTH_DEV_SHARED_SECRET?: string;
  /** Email allowlist promoted to admin in dev or OIDC sessions. */
  AUTH_ADMIN_EMAILS?: string;
  /** Legacy system display name retained for existing deploy-time config. */
  SYSTEM_NAME?: string;
  /** Legacy admin key retained for backwards-compatible env surfaces. */
  ADMIN_KEY?: string;
  /** Optional Cloudflare account id used by some legacy browser-rendering flows. */
  CF_ACCOUNT_ID?: string;
  /** OIDC issuer identifier or canonical URL. */
  AUTH_OIDC_ISSUER?: string;
  /** OIDC authorization endpoint. */
  AUTH_OIDC_AUTHORIZATION_ENDPOINT?: string;
  /** OIDC token endpoint. */
  AUTH_OIDC_TOKEN_ENDPOINT?: string;
  /** OIDC JWKS endpoint. */
  AUTH_OIDC_JWKS_URL?: string;
  /** Inline JWKS JSON override for locked-down environments. */
  AUTH_OIDC_JWKS_JSON?: string;
  /** OIDC client identifier. */
  AUTH_OIDC_CLIENT_ID?: string;
  /** OIDC client secret. */
  AUTH_OIDC_CLIENT_SECRET?: string;
  /** OIDC redirect URI override. */
  AUTH_OIDC_REDIRECT_URI?: string;
  /** OIDC scope list. */
  AUTH_OIDC_SCOPE?: string;
  /** Claim name holding the role. */
  AUTH_OIDC_ROLE_CLAIM?: string;
  /** Claim name holding the institution scope. */
  AUTH_OIDC_INSTITUTION_CLAIM?: string;
  /** Claim name holding course ids. */
  AUTH_OIDC_COURSES_CLAIM?: string;
  /** Claim name holding display name. */
  AUTH_OIDC_NAME_CLAIM?: string;
  /** Claim name holding email. */
  AUTH_OIDC_EMAIL_CLAIM?: string;
  /** Soft target for minimum unique sources in free-response mode. */
  FREE_RESPONSE_MIN_UNIQUE_SOURCES?: string;
  /** Alias for minimum distinct sources (legacy or alternate config). */
  MIN_DISTINCT_SOURCES?: string;
  /** If truthy, hard-enforces minimum distinct sources. */
  ENFORCE_MIN_DISTINCT_SOURCES?: string;
  /** Free-response specific enforcement toggle. */
  FREE_RESPONSE_ENFORCE_MIN_UNIQUE_SOURCES?: string;
  /** Enables the Universal Answer Orchestrator when truthy. */
  UAO_ENABLED?: string;
  /** Enables LLM-based micro-classifier for UAO when truthy. */
  UAO_LLM_CLASSIFIER_ENABLED?: string;
  /** Enables LLM-based QC pass for UAO when truthy. */
  UAO_LLM_QC_ENABLED?: string;
  /** Confidence threshold for invoking the UAO LLM classifier. */
  UAO_CLASSIFIER_CONFIDENCE_THRESHOLD?: string;
  /** Character threshold for long-answer render hints. */
  LONG_ANSWER_THRESHOLD_CHARS?: string;
  /** Optional typewriter speed override (ms per tick). */
  TYPEWRITER_SPEED?: string;
  /** Enables planner-owned structured segment streaming for eligible chat turns. */
  OWEN_STRUCTURED_CHAT_V2_ENABLED?: string;
  /** Enables derived structured streaming from the standard chat stream when truthy. */
  OWEN_DERIVED_STRUCTURED_STREAM_ENABLED?: string;
  /** Enables persisted conversation compaction when truthy. */
  OWEN_CONVERSATION_COMPACTION_ENABLED?: string;
  /** Estimated token threshold for persisted conversation compaction. */
  OWEN_CONVERSATION_COMPACTION_MAX_ESTIMATED_TOKENS?: string;
  /** Number of newest persisted conversation messages to preserve verbatim. */
  OWEN_CONVERSATION_COMPACTION_PRESERVE_RECENT_MESSAGES?: string;
  /** Enables in-process runtime hooks when truthy. */
  OWEN_RUNTIME_HOOKS_ENABLED?: string;
  /** Enables normalized usage tracking logs when truthy. */
  OWEN_USAGE_TRACKING_ENABLED?: string;
  /** Enables the Worker-native runtime capability gate. */
  ENABLE_RUNTIME_CAPABILITY_GATE?: string;
  /** Enables versioned typed session persistence. */
  ENABLE_SESSION_V2?: string;
  /** Enables first-class session resume APIs and metadata. */
  ENABLE_SESSION_RESUME?: string;
  /** Enables first-class usage event persistence. */
  ENABLE_USAGE_TRACKING?: string;
  /** Enables faculty cost tracking UI integrations when editable client source exists. */
  ENABLE_COST_TRACKING_UI?: string;
  /** Enables deterministic runtime fixture/parity mode. */
  ENABLE_PARITY_FIXTURE_MODE?: string;
  /** Enables KV-backed runtime config overrides from OWEN_DIAG_KV. */
  ENABLE_RUNTIME_CONFIG_KV_OVERRIDES?: string;
  /** Optional JSON runtime-flag overrides. */
  RUNTIME_FLAGS_JSON?: string;
  /** Optional JSON model pricing overrides. */
  MODEL_PRICING_OVERRIDES_JSON?: string;
  /** Explicit kill switch for inline multimodal chat image parts. Defaults to enabled when unset. */
  OWEN_VISION_ENABLED?: string;
  /** Enables auto-selection of medical vision prompt overlays when truthy. */
  OWEN_MEDICAL_VISION_PROMPTS_ENABLED?: string;
  /** Max raw bytes allowed before inline chat images are uploaded as OpenAI vision files. */
  OWEN_VISION_INLINE_MAX_BYTES?: string;
  /** Enables future vision dedupe caching in R2/KV when truthy. */
  OWEN_VISION_R2_CACHE_ENABLED?: string;
  /** Enables future multi-image specific behavior flags when truthy. */
  OWEN_VISION_MULTI_IMAGE_ENABLED?: string;
  /** Optional persistent vector store id for retrieval calls. */
  VECTOR_STORE_ID?: string;
  /** KV namespace for doc metadata and cached artifacts. */
  DOCS_KV?: KVNamespace;
  /** KV namespace for lecture document cache entries. */
  OWEN_DOC_CACHE?: KVNamespace;
  /** KV namespace for diagnostics (request snapshots, analytics key, etc.). */
  OWEN_DIAG_KV?: KVNamespace;
  /** Durable Object namespace for global live presence coordination. */
  PRESENCE_ROOM: DurableObjectNamespace;
  /** Model id override for image generation (gpt-image-1). */
  GPT_IMAGE_1_MODEL_ID?: string;
  /** Model id override for mini image generation. */
  GPT_IMAGE_1_MINI_MODEL_ID?: string;
  /** Model id override for DALL-E 3. */
  DALLE3_MODEL_ID?: string;
  /** Model id override for DALL-E 2. */
  DALLE2_MODEL_ID?: string;
  /** R2 bucket for primary document storage. */
  OWEN_BUCKET: R2Bucket;
  /** R2 bucket for ingest staging. */
  OWEN_INGEST: R2Bucket;
  /** R2 bucket for notes or curated content. */
  OWEN_NOTES: R2Bucket;
  /** R2 bucket for test fixtures. */
  OWEN_TEST: R2Bucket;
  /** R2 bucket for user uploads (default). */
  OWEN_UPLOADS: R2Bucket;
  /** R2 bucket for analytics exports. */
  OWEN_ANALYTICS: R2Bucket;
  /** Legacy bucket binding (typo or alternate name). */
  OWN_INGEST: R2Bucket;
}
