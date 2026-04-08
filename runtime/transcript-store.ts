export interface TranscriptMessage {
  id?: string;
  role: string;
  content: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TranscriptReplay {
  messages: TranscriptMessage[];
  totalChars: number;
  truncated: boolean;
}

export interface TranscriptCompactionOptions {
  maxMessages?: number;
  maxChars?: number;
}

const DEFAULT_MAX_MESSAGES = 400;
const DEFAULT_MAX_CHARS = 600_000;

export function compactTranscriptMessages(
  messages: TranscriptMessage[],
  opts: TranscriptCompactionOptions = {},
): TranscriptReplay {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const sliced = messages.slice(-maxMessages);
  const replay: TranscriptMessage[] = [];
  let totalChars = 0;

  for (let index = sliced.length - 1; index >= 0; index -= 1) {
    const message = sliced[index];
    if (!message) continue;
    const nextChars = totalChars + message.content.length;
    if (replay.length > 0 && nextChars > maxChars) break;
    replay.unshift(message);
    totalChars = nextChars;
  }

  return {
    messages: replay,
    totalChars,
    truncated: replay.length !== messages.length,
  };
}

export function replayTranscript(messages: TranscriptMessage[]): TranscriptReplay {
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return {
    messages: [...messages],
    totalChars,
    truncated: false,
  };
}
