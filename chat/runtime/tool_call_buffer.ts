type RawToolCallState = {
  id: string;
  name: string;
  argumentsText: string;
};

export type CompletedToolCall = {
  id: string;
  name: string;
  argumentsText: string;
  arguments: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractToolItem(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  if (!record) return null;
  const candidates = [record.item, record.output_item, record.outputItem];
  for (const candidate of candidates) {
    const item = asRecord(candidate);
    if (!item) continue;
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "function_call") return item;
  }
  const directType = typeof record.type === "string" ? record.type : "";
  return directType === "function_call" ? record : null;
}

function extractId(payload: Record<string, unknown>, item?: Record<string, unknown> | null): string {
  const candidates = [
    item?.id,
    payload.item_id,
    payload.itemId,
    item?.call_id,
    item?.callId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function extractName(payload: Record<string, unknown>, item?: Record<string, unknown> | null): string {
  const candidates = [
    item?.name,
    asRecord(item?.function)?.name,
    payload.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function extractArgumentsText(payload: Record<string, unknown>, item?: Record<string, unknown> | null): string {
  const candidates = [
    payload.arguments,
    payload.arguments_text,
    payload.argumentsText,
    item?.arguments,
    item?.arguments_text,
    item?.argumentsText,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function extractArgumentsDelta(payload: Record<string, unknown>): string {
  const candidates = [payload.delta, payload.arguments_delta, payload.argumentsDelta];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export class ToolCallBuffer {
  private readonly calls = new Map<string, RawToolCallState>();

  pushFrame(eventName: string | undefined, payload: unknown): CompletedToolCall[] {
    const completed: CompletedToolCall[] = [];
    const record = asRecord(payload);
    if (!record) return completed;

    const item = extractToolItem(record);
    const itemId = extractId(record, item);
    const itemName = extractName(record, item);

    if (itemId && itemName) {
      const existing = this.calls.get(itemId);
      this.calls.set(itemId, {
        id: itemId,
        name: itemName,
        argumentsText: existing?.argumentsText || "",
      });
    }

    if (eventName === "response.function_call_arguments.delta" || eventName === "response.output_item.delta") {
      const delta = extractArgumentsDelta(record);
      if (itemId && delta) {
        const current = this.calls.get(itemId);
        if (current) current.argumentsText += delta;
      }
      return completed;
    }

    const argumentsText = extractArgumentsText(record, item);
    if (!itemId || !argumentsText) return completed;
    const current = this.calls.get(itemId) || {
      id: itemId,
      name: itemName,
      argumentsText: "",
    };
    if (!current.name && itemName) current.name = itemName;
    if (!current.argumentsText || argumentsText.length >= current.argumentsText.length) {
      current.argumentsText = argumentsText;
    }
    this.calls.set(itemId, current);

    const parsed = safeParseObject(current.argumentsText);
    if (!parsed || !current.name) return completed;
    this.calls.delete(itemId);
    completed.push({
      id: current.id,
      name: current.name,
      argumentsText: current.argumentsText,
      arguments: parsed,
    });
    return completed;
  }
}
