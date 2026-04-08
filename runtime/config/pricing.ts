export interface RuntimeModelPricing {
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cacheCreationUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
}

export type RuntimePricingTable = Record<string, RuntimeModelPricing>;

export interface RuntimePricingConfig {
  version: string;
  source: "defaults" | "env_json" | "kv" | "test_override";
  models: RuntimePricingTable;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizePricingEntry(raw: unknown): RuntimeModelPricing | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const pricing: RuntimeModelPricing = {};
  if (isFiniteNumber(source.inputUsdPerMillion)) pricing.inputUsdPerMillion = source.inputUsdPerMillion;
  if (isFiniteNumber(source.outputUsdPerMillion)) pricing.outputUsdPerMillion = source.outputUsdPerMillion;
  if (isFiniteNumber(source.cacheCreationUsdPerMillion)) pricing.cacheCreationUsdPerMillion = source.cacheCreationUsdPerMillion;
  if (isFiniteNumber(source.cacheReadUsdPerMillion)) pricing.cacheReadUsdPerMillion = source.cacheReadUsdPerMillion;
  return Object.keys(pricing).length ? pricing : null;
}

export function normalizePricingTable(raw: unknown): RuntimePricingTable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const table: RuntimePricingTable = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedModel = model.trim();
    if (!normalizedModel) continue;
    const pricing = normalizePricingEntry(value);
    if (!pricing) continue;
    table[normalizedModel] = pricing;
  }
  return table;
}

export function mergePricingTables(...tables: Array<RuntimePricingTable | undefined | null>): RuntimePricingTable {
  const merged: RuntimePricingTable = {};
  for (const table of tables) {
    if (!table) continue;
    for (const [model, pricing] of Object.entries(table)) {
      merged[model] = { ...(merged[model] || {}), ...pricing };
    }
  }
  return merged;
}
