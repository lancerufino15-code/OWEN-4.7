/**
 * Public re-exports for study guide validation helpers.
 *
 * Used by: `src/index.ts` and tests to import runtime validators from a stable path.
 *
 * Key exports:
 * - Re-exported validators from `validate.runtime` (structure, coverage, style).
 *
 * Assumptions:
 * - This barrel stays in sync with `validate.runtime` to provide a stable import path.
 */
export {
  ensureMaximalCoverage,
  ensureMaximalDiscriminatorColumns,
  ensureMaximalDrugCoverage,
  ensureMaximalPlaceholderQuality,
  ensureMaximalTopicClassification,
  ensureMaximalTopicDensity,
  validateMaximalStructure,
  validateStyleContract,
} from "./validate.runtime.ts";
