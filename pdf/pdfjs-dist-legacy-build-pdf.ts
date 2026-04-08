/**
 * Stub module that mimics the minimal pdfjs-dist API used by this worker.
 *
 * Used by: `src/index.ts` to avoid hard runtime failures when pdfjs-dist is not
 * installed locally or in certain deployment environments.
 *
 * Key exports:
 * - `getDocument`/`GlobalWorkerOptions`: minimal pdfjs API surface.
 * - `__isStub`: marker used to detect fallback behavior.
 *
 * Assumptions:
 * - Downstream callers handle rejected promises as "pdfjs unavailable".
 */
/** Marker flag to indicate this module is a stub implementation. */
export const __isStub = true;
/** Minimal worker options object to satisfy pdfjs usage sites. */
export const GlobalWorkerOptions: { workerSrc?: string } = { workerSrc: undefined };

/**
 * Stub pdfjs `getDocument` that always rejects with a missing dependency error.
 *
 * @returns Object containing a rejected promise.
 */
export function getDocument(..._args: any[]): { promise: Promise<any> } {
  const err = new Error("pdfjs-dist is not installed. Run npm install to enable PDF parsing.");
  return { promise: Promise.reject(err) };
}

export default { getDocument, GlobalWorkerOptions, __isStub };
