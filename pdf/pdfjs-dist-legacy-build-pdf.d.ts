/**
 * Type declarations for the pdfjs stub module used in the worker.
 *
 * Used by: `src/index.ts` and any TS imports of `pdfjs-dist-legacy-build-pdf.mjs`.
 *
 * Key exports:
 * - `getDocument`, `GlobalWorkerOptions`, `__isStub`: minimal PDF.js surface area used by the worker.
 *
 * Assumptions:
 * - This is a type-only shim; runtime behavior comes from the `.mjs` bundle.
 */
declare module "./pdfjs-dist-legacy-build-pdf.mjs" {
  const __isStub: boolean;
  const GlobalWorkerOptions: { workerSrc?: string };
  function getDocument(...args: any[]): any;
  export { __isStub, GlobalWorkerOptions, getDocument };
  const _default: any;
  export default _default;
}
