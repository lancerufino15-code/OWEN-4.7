import { encodeSSE } from "../../runtime/http";
import type { ChatStreamEvent } from "./types";

function isLegacyMessageDelta(event: ChatStreamEvent): event is Extract<ChatStreamEvent, { event: "message_delta" }> {
  return event.event === "message_delta";
}

function isLegacyFinal(event: ChatStreamEvent): event is Extract<ChatStreamEvent, { event: "final" }> {
  return event.event === "final";
}

export function encodeChatEvent(event: ChatStreamEvent): Uint8Array[] {
  const frames: Uint8Array[] = [];
  frames.push(encodeSSE({ event: event.event, data: JSON.stringify(event) }));

  if (event.event === "message_start") {
    frames.push(
      encodeSSE({
        event: "message",
        data: JSON.stringify({
          resolvedResponseMode: event.resolvedResponseMode,
          model: event.model,
          conversationId: event.conversationId,
        }),
      }),
    );
  }

  if (isLegacyMessageDelta(event)) {
    frames.push(encodeSSE({ event: "message", data: JSON.stringify({ delta: event.delta }) }));
  }

  if (isLegacyFinal(event)) {
    frames.push(
      encodeSSE({
        event: "final",
        data: JSON.stringify({
          ok: true,
          content: event.content,
          answerSegments: event.answerSegments,
          sources: event.sources,
          responseV2: event.responseV2,
          consultedSources: event.consultedSources,
          renderHints: event.renderHints,
          finishReason: event.finishReason,
          incompleteReason: event.incompleteReason,
          truncated: event.truncated,
          resolvedResponseMode: event.resolvedResponseMode,
        }),
      }),
    );
  }

  if (event.event === "done") {
    frames.push(encodeSSE({ event: "done", data: "{}" }));
  }

  return frames;
}
