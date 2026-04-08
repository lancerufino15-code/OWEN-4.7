export type RuntimeHookStage =
  | "before_responses_call"
  | "after_responses_call"
  | "before_tool_selection"
  | "after_tool_selection"
  | "before_conversation_compaction"
  | "after_conversation_compaction";

export type RuntimeHookPayload = Record<string, unknown>;

export type RuntimeHookResult = {
  action?: "allow" | "deny";
  reason?: string;
  metadata?: Record<string, unknown>;
};

type RuntimeHookHandler = (payload: RuntimeHookPayload) => RuntimeHookResult | void | Promise<RuntimeHookResult | void>;

const hookRegistry = new Map<RuntimeHookStage, Set<RuntimeHookHandler>>();

export function registerRuntimeHook(stage: RuntimeHookStage, handler: RuntimeHookHandler): () => void {
  const handlers = hookRegistry.get(stage) || new Set<RuntimeHookHandler>();
  handlers.add(handler);
  hookRegistry.set(stage, handlers);
  return () => {
    handlers.delete(handler);
    if (!handlers.size) hookRegistry.delete(stage);
  };
}

export function resetRuntimeHooksForTests(): void {
  hookRegistry.clear();
}

export async function runRuntimeHooks(
  stage: RuntimeHookStage,
  payload: RuntimeHookPayload,
  opts: { enabled?: boolean } = {},
): Promise<{ denied: boolean; reasons: string[]; results: RuntimeHookResult[] }> {
  if (!opts.enabled) {
    return { denied: false, reasons: [], results: [] };
  }

  const handlers = Array.from(hookRegistry.get(stage) || []);
  const reasons: string[] = [];
  const results: RuntimeHookResult[] = [];

  for (const handler of handlers) {
    try {
      const result = await handler(payload);
      if (!result) continue;
      results.push(result);
      if (result.action === "deny") {
        reasons.push(result.reason || "denied");
      }
    } catch (error) {
      console.warn("[runtime.hooks] handler failed", {
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    denied: reasons.length > 0,
    reasons,
    results,
  };
}
