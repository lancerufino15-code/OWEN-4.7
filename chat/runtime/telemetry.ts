import type { ChatTelemetry } from "./types";

export class ChatTurnTelemetry {
  private readonly startedAt = Date.now();
  private readonly telemetry: ChatTelemetry;

  constructor(modelUsed: string) {
    this.telemetry = {
      compactionTriggered: false,
      sourceCount: 0,
      modelUsed,
      continuationAttempts: 0,
      truncated: false,
    };
  }

  markFirstToken() {
    if (typeof this.telemetry.firstTokenMs === "number") return;
    this.telemetry.firstTokenMs = Date.now() - this.startedAt;
  }

  setRetrievalMs(ms: number) {
    this.telemetry.retrievalMs = ms;
  }

  setQaMs(ms: number) {
    this.telemetry.qaMs = ms;
  }

  setCompactionTriggered(triggered: boolean) {
    this.telemetry.compactionTriggered = triggered;
  }

  setSourceCount(count: number) {
    this.telemetry.sourceCount = Math.max(0, count);
  }

  setContinuationAttempts(attempts: number) {
    this.telemetry.continuationAttempts = Math.max(0, attempts);
  }

  setTruncated(truncated: boolean) {
    this.telemetry.truncated = truncated;
  }

  setModelUsed(modelUsed: string) {
    this.telemetry.modelUsed = modelUsed;
  }

  finalize(): ChatTelemetry {
    this.telemetry.totalMs = Date.now() - this.startedAt;
    return { ...this.telemetry };
  }
}
