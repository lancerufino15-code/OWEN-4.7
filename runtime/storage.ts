import type { Env } from "../../types";

export const BUCKET_BINDINGS = {
  "owen-bucket": "OWEN_BUCKET",
  "owen-ingest": "OWEN_INGEST",
  "owen-notes": "OWEN_NOTES",
  "owen-test": "OWEN_TEST",
  "owen-uploads": "OWEN_UPLOADS",
  "own-ingest": "OWN_INGEST",
} as const;

export const DEFAULT_BUCKET = "owen-uploads" as const;
export const CANONICAL_CACHE_BUCKET_NAME = "owen-ingest" as const;

let loggedCanonicalBucket = false;

function isR2BucketLike(value: unknown): value is R2Bucket {
  return Boolean(value) && typeof (value as R2Bucket).put === "function" && typeof (value as R2Bucket).get === "function";
}

export function lookupBucket(env: Env, identifier?: string | null) {
  if (!identifier) return null;
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const envRecord = env as unknown as Record<string, unknown>;

  const direct = envRecord[trimmed];
  if (isR2BucketLike(direct)) {
    return { bucket: direct as R2Bucket, name: trimmed };
  }

  const upper = trimmed.toUpperCase();
  if (upper !== trimmed) {
    const upperMatch = envRecord[upper];
    if (isR2BucketLike(upperMatch)) {
      return { bucket: upperMatch as R2Bucket, name: upper };
    }
  }

  const lower = trimmed.toLowerCase();
  if (lower in BUCKET_BINDINGS) {
    const bindingName = BUCKET_BINDINGS[lower as keyof typeof BUCKET_BINDINGS];
    const bindingBucket = envRecord[bindingName];
    if (isR2BucketLike(bindingBucket)) {
      return { bucket: bindingBucket as R2Bucket, name: bindingName };
    }
  }

  return null;
}

export function getBucketByName(env: Env, name: string) {
  const lookup = lookupBucket(env, name);
  if (!lookup) throw new Error(`Unknown bucket ${name}`);
  return lookup.bucket;
}

export function resolveBucketKey(bindingName: string) {
  const entry = Object.entries(BUCKET_BINDINGS).find(([, binding]) => binding === bindingName);
  return entry ? entry[0] : bindingName;
}

export function sanitizeKey(input: string | null, fallback: string) {
  if (!input) return fallback;
  const safe = input
    .trim()
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\.+/, "");
  return safe || fallback;
}

export function sanitizeFilename(name: string) {
  return name.replace(/[^\w.\-]+/g, "_");
}

export async function findObjectInBucket(bucket: R2Bucket, candidateKey: string) {
  const attempts = new Set<string>();
  const trimmed = candidateKey.trim();
  if (trimmed) attempts.add(trimmed);
  const sanitized = sanitizeKey(trimmed, trimmed);
  if (sanitized) attempts.add(sanitized);

  for (const key of attempts) {
    try {
      const obj = await bucket.get(key);
      if (obj && obj.body) return { object: obj, key };
    } catch {
      // ignore and keep probing
    }
  }

  for (const prefix of attempts) {
    if (!prefix) continue;
    try {
      const list = await bucket.list({ prefix });
      const match = list.objects?.[0];
      if (match) {
        const obj = await bucket.get(match.key);
        if (obj && obj.body) return { object: obj, key: match.key };
      }
    } catch {
      // ignore and fall through
    }
  }

  try {
    const list = await bucket.list();
    const match = list.objects?.find((obj) => Array.from(attempts).some((value) => value && obj.key.endsWith(value)));
    if (match) {
      const obj = await bucket.get(match.key);
      if (obj && obj.body) return { object: obj, key: match.key };
    }
  } catch {
    // ignore and return null
  }

  return null;
}

export function getCanonicalCacheBucket(env: Env) {
  const lookup =
    lookupBucket(env, CANONICAL_CACHE_BUCKET_NAME) ||
    lookupBucket(env, BUCKET_BINDINGS[CANONICAL_CACHE_BUCKET_NAME as keyof typeof BUCKET_BINDINGS]);
  if (!lookup) {
    throw new Error("No canonical cache bucket configured.");
  }
  if (!loggedCanonicalBucket) {
    loggedCanonicalBucket = true;
    const available = Object.keys(BUCKET_BINDINGS).map((name) => ({
      name,
      binding: BUCKET_BINDINGS[name as keyof typeof BUCKET_BINDINGS],
      present: Boolean((env as any)[BUCKET_BINDINGS[name as keyof typeof BUCKET_BINDINGS]]),
    }));
    console.log("[LIBRARY] canonical cache bucket resolved", { canonical: lookup.name, available });
  }
  return lookup;
}

export function getLibraryBucket(env: Env) {
  return getCanonicalCacheBucket(env);
}

export function getExtractionBucket(env: Env) {
  return getCanonicalCacheBucket(env);
}

export function getPublishBucket(env: Env) {
  return getCanonicalCacheBucket(env);
}

export function resolveBucket(env: Env, choice: FormDataEntryValue | null) {
  const requested = typeof choice === "string" ? choice : null;
  if ((requested || "").trim().toLowerCase() === "library") {
    return getLibraryBucket(env);
  }
  const defaultBinding = BUCKET_BINDINGS[DEFAULT_BUCKET];
  const lookup =
    lookupBucket(env, requested) ??
    lookupBucket(env, defaultBinding) ??
    lookupBucket(env, DEFAULT_BUCKET);
  if (!lookup) {
    throw new Error("No matching R2 bucket binding configured.");
  }
  return lookup;
}

export function resolveUploadPrefix(choice: FormDataEntryValue | null): string {
  const value = typeof choice === "string" ? choice : "";
  if (!value) return "";
  switch (value) {
    case "anki_decks":
      return "Anki Decks/";
    case "study_guides":
      return "Study Guides/";
    case "library":
      return "library/";
    default:
      return "";
  }
}

export function buildLibraryDownloadUrl(bucket: string, key: string) {
  return `/api/file?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`;
}

export type LibraryArtifactSummary = {
  exists: boolean;
  updatedAt?: string;
  size?: number;
};

export type ObjectHeadInfo = {
  exists: boolean;
  uploaded?: Date;
  size?: number;
  contentType?: string;
};

export async function resolveObjectHead(bucket: R2Bucket, key: string): Promise<ObjectHeadInfo> {
  if (!key) return { exists: false };
  try {
    const head = typeof bucket.head === "function"
      ? await bucket.head(key)
      : await bucket.get(key, { range: { offset: 0, length: 0 } as any });
    if (!head) return { exists: false };
    const uploaded = (head as any).uploaded instanceof Date ? (head as any).uploaded : undefined;
    return {
      exists: true,
      uploaded,
      size: (head as any).size,
      contentType: (head as any).httpMetadata?.contentType,
    };
  } catch {
    return { exists: false };
  }
}

export function summarizeArtifact(head: ObjectHeadInfo | null): LibraryArtifactSummary {
  if (!head || !head.exists) return { exists: false };
  return {
    exists: true,
    updatedAt: head.uploaded ? head.uploaded.toISOString() : undefined,
    size: head.size,
  };
}
