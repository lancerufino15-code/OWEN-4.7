import type { Env } from "../../types";
import { delay, openAIJsonFetch } from "./openai";

const VECTOR_POLL_INTERVAL_MS = 1500;
const VECTOR_POLL_TIMEOUT_MS = 45_000;
const VECTOR_STORE_CACHE_KEY = "owen.vector_store_id";

let inMemoryVectorStoreId: string | null = null;

export async function attachFileToVectorStore(env: Env, storeId: string, fileId: string) {
  await openAIJsonFetch(env, `/vector_stores/${storeId}/files`, {
    method: "POST",
    json: { file_id: fileId },
  });
  return waitForVectorStoreFile(env, storeId, fileId);
}

export async function waitForVectorStoreFile(env: Env, storeId: string, fileId: string) {
  const deadline = Date.now() + VECTOR_POLL_TIMEOUT_MS;
  let lastStatus = "queued";
  while (Date.now() < deadline) {
    const record = await fetchVectorStoreFileStatus(env, storeId, fileId);
    if (record.status === "completed") {
      return "completed";
    }
    if (record.status === "failed") {
      throw new Error(record.last_error || "Vector store indexing failed.");
    }
    lastStatus = record.status || lastStatus;
    await delay(VECTOR_POLL_INTERVAL_MS);
  }
  return lastStatus || "processing";
}

export async function fetchVectorStoreFileStatus(env: Env, storeId: string, fileId: string) {
  const data = await openAIJsonFetch(env, `/vector_stores/${storeId}/files/${fileId}`, { method: "GET" });
  return {
    status: typeof data?.status === "string" ? data.status : undefined,
    last_error: typeof data?.last_error?.message === "string" ? data.last_error.message : undefined,
  };
}

export async function getPersistedVectorStoreId(env: Env) {
  if (env.VECTOR_STORE_ID?.trim()) return env.VECTOR_STORE_ID.trim();
  if (inMemoryVectorStoreId) return inMemoryVectorStoreId;
  if (env.DOCS_KV) {
    const stored = await env.DOCS_KV.get(VECTOR_STORE_CACHE_KEY);
    if (stored) {
      inMemoryVectorStoreId = stored;
      return stored;
    }
  }
  return null;
}

export async function getOrCreateVectorStoreId(env: Env, label?: string) {
  const existing = await getPersistedVectorStoreId(env);
  if (existing) return existing;
  const now = new Date().toISOString();
  const name = label ? `OWEN • ${label}` : "OWEN Knowledge Base";
  const store = await openAIJsonFetch(env, "/vector_stores", {
    method: "POST",
    json: {
      name: name.slice(0, 60),
      metadata: { created_at: now },
    },
  });
  const storeId = typeof store?.id === "string" ? store.id : "";
  if (!storeId) throw new Error("OpenAI did not return a vector_store id.");
  inMemoryVectorStoreId = storeId;
  if (env.DOCS_KV) {
    await env.DOCS_KV.put(VECTOR_STORE_CACHE_KEY, storeId);
  }
  return storeId;
}
