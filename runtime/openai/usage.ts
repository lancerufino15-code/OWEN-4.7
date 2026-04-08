export type NormalizedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

export type UsagePricing = {
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cacheCreationUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
};

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function finalizeUsage(usage: Omit<NormalizedUsage, "totalTokens">): NormalizedUsage {
  return {
    ...usage,
    totalTokens:
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheCreationInputTokens +
      usage.cacheReadInputTokens,
  };
}

export function extractResponsesUsage(payload: any): NormalizedUsage {
  const usage = payload?.usage || payload?.response?.usage || {};
  return finalizeUsage({
    inputTokens: normalizeCount(usage?.input_tokens ?? usage?.prompt_tokens),
    outputTokens: normalizeCount(usage?.output_tokens ?? usage?.completion_tokens),
    cacheCreationInputTokens: normalizeCount(usage?.cache_creation_input_tokens),
    cacheReadInputTokens: normalizeCount(usage?.cache_read_input_tokens),
  });
}

export function extractChatCompletionsUsage(payload: any): NormalizedUsage {
  const usage = payload?.usage || {};
  return finalizeUsage({
    inputTokens: normalizeCount(usage?.prompt_tokens ?? usage?.input_tokens),
    outputTokens: normalizeCount(usage?.completion_tokens ?? usage?.output_tokens),
    cacheCreationInputTokens: normalizeCount(usage?.cache_creation_input_tokens),
    cacheReadInputTokens: normalizeCount(usage?.cache_read_input_tokens),
  });
}

export function extractOpenAIUsage(payload: any, mode?: "responses" | "chat_completions"): NormalizedUsage {
  if (mode === "chat_completions") return extractChatCompletionsUsage(payload);
  if (mode === "responses") return extractResponsesUsage(payload);
  if (payload?.choices) return extractChatCompletionsUsage(payload);
  return extractResponsesUsage(payload);
}

export function estimateUsageCost(usage: NormalizedUsage, pricing?: UsagePricing): number | undefined {
  if (!pricing) return undefined;
  const input = (pricing.inputUsdPerMillion || 0) * usage.inputTokens / 1_000_000;
  const output = (pricing.outputUsdPerMillion || 0) * usage.outputTokens / 1_000_000;
  const cacheCreation = (pricing.cacheCreationUsdPerMillion || 0) * usage.cacheCreationInputTokens / 1_000_000;
  const cacheRead = (pricing.cacheReadUsdPerMillion || 0) * usage.cacheReadInputTokens / 1_000_000;
  return input + output + cacheCreation + cacheRead;
}

export class UsageTracker {
  private latestUsage: NormalizedUsage = finalizeUsage({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });

  private cumulativeUsage: NormalizedUsage = finalizeUsage({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });

  private turns = 0;

  record(usage: NormalizedUsage): void {
    this.latestUsage = usage;
    this.cumulativeUsage = finalizeUsage({
      inputTokens: this.cumulativeUsage.inputTokens + usage.inputTokens,
      outputTokens: this.cumulativeUsage.outputTokens + usage.outputTokens,
      cacheCreationInputTokens: this.cumulativeUsage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      cacheReadInputTokens: this.cumulativeUsage.cacheReadInputTokens + usage.cacheReadInputTokens,
    });
    this.turns += 1;
  }

  latest(): NormalizedUsage {
    return this.latestUsage;
  }

  cumulative(): NormalizedUsage {
    return this.cumulativeUsage;
  }

  turnCount(): number {
    return this.turns;
  }
}
