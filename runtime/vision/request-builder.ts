import type { Env } from "../../../types";
import type { FileReference } from "../../chat/types";
import type { FileContextRecord, ResponsesInputContent, ResponsesInputMessage } from "../../chat/runtime/types";
import { messageContentToPlainText } from "./messages";
import { prepareVisionInputFromPart } from "./ingest";
import type { VisionChatMessage } from "./types";

type BuildVisionResponsesInputOptions = {
  env: Env;
  explicitSystemMessages: VisionChatMessage[];
  historyMessages: VisionChatMessage[];
  fileContexts: FileContextRecord[];
  topChunks: Map<string, string[]>;
  visionFiles: FileReference[];
  inlineMaxBytes?: number;
};

function buildFileContextInputs(
  inputs: ResponsesInputMessage[],
  fileContexts: FileContextRecord[],
  topChunks: Map<string, string[]>,
) {
  fileContexts.forEach((context) => {
    const label = context.displayName || context.resolvedKey || context.originalKey;
    const prefix = `Attachment (${context.source === "ocr" ? "OCR" : "text"}): ${label}`;
    const chunks = topChunks.get(context.resolvedKey) || [context.text];
    chunks.forEach((chunk, index) => {
      inputs.push({
        role: "user",
        content: [{ type: "input_text", text: `${prefix}\nChunk ${index + 1}:\n${chunk}` }],
      });
    });
  });
}

function buildSyntheticVisionAttachmentInputs(inputs: ResponsesInputMessage[], visionFiles: FileReference[]) {
  const seenVisionIds = new Set<string>();
  visionFiles.forEach((file) => {
    if (!file.visionFileId || seenVisionIds.has(file.visionFileId)) return;
    seenVisionIds.add(file.visionFileId);
    const content: ResponsesInputContent[] = [
      {
        type: "input_text",
        text: `Vision attachment: ${file.displayName || file.key}. Read the image carefully and use it as evidence.`,
      },
      { type: "input_image", file_id: file.visionFileId, detail: "high" },
    ];
    inputs.push({ role: "user", content });
  });
}

async function buildHistoryMessageContent(
  env: Env,
  message: VisionChatMessage,
  inlineMaxBytes?: number,
  messageIndex = 0,
): Promise<ResponsesInputContent[]> {
  if (message.role !== "user") {
    const text = messageContentToPlainText(message.content).trim();
    if (!text) return [];
    return [{ type: message.role === "assistant" ? "output_text" : "input_text", text }];
  }

  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text ? [{ type: "input_text", text }] : [];
  }

  const content: ResponsesInputContent[] = [];
  for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
    const part = message.content[partIndex]!;
    if (part.type === "text") {
      const text = part.text.trim();
      if (text) content.push({ type: "input_text", text });
      continue;
    }
    content.push(
      await prepareVisionInputFromPart(env, part, {
        inlineMaxBytes,
        filenamePrefix: `chat-inline-${messageIndex + 1}-${partIndex + 1}`,
      }),
    );
  }
  return content;
}

export async function buildVisionResponsesInput(opts: BuildVisionResponsesInputOptions): Promise<ResponsesInputMessage[]> {
  const inputs: ResponsesInputMessage[] = [];

  opts.explicitSystemMessages.forEach((message) => {
    const text = messageContentToPlainText(message.content).trim();
    if (!text) return;
    inputs.push({ role: "system", content: [{ type: "input_text", text }] });
  });

  buildFileContextInputs(inputs, opts.fileContexts, opts.topChunks);
  buildSyntheticVisionAttachmentInputs(inputs, opts.visionFiles);

  for (let index = 0; index < opts.historyMessages.length; index += 1) {
    const message = opts.historyMessages[index]!;
    if (message.role === "system") continue;
    const content = await buildHistoryMessageContent(opts.env, message, opts.inlineMaxBytes, index);
    if (!content.length) continue;
    inputs.push({ role: message.role, content });
  }

  return inputs;
}
