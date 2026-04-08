import type { Env } from "../../types";
import { json } from "../runtime/http";
import { buildLibraryDownloadUrl, getBucketByName } from "../runtime/storage";

export async function handleSignedUrlRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const bucketName = url.searchParams.get("bucket") || "";
  const key = url.searchParams.get("key") || "";
  if (!bucketName || !key) {
    return json({ error: "Missing bucket or key." }, 400);
  }

  try {
    const bucket = getBucketByName(env, bucketName);
    const exists = typeof bucket.head === "function"
      ? await bucket.head(key)
      : await bucket.get(key, { range: { offset: 0, length: 0 } as any });
    if (!exists) return json({ error: "Not found." }, 404);
  } catch (err) {
    return json({ error: "Not found", details: err instanceof Error ? err.message : String(err) }, 404);
  }

  return json({ url: buildLibraryDownloadUrl(bucketName, key), bucket: bucketName, key });
}
