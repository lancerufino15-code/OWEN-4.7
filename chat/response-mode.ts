import type { ResolvedResponseMode, ResponseMode } from "./types";

const PHATIC_WORDS = new Set(["hi", "hello", "hey", "yo", "thanks", "thx", "ok", "okay", "k", "lol", "sup"]);
const SIMPLE_ARITHMETIC_REGEX =
  /^(?:what\s+is|what's|whats|calculate|compute)?\s*([-+]?\d+(?:\.\d+)?)\s*([+\-*/])\s*([-+]?\d+(?:\.\d+)?)(?:\s*(?:=|\?)\s*)?$/i;

export function normalizeResponseMode(value: unknown): ResponseMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "auto" || normalized === "instant" || normalized === "thinking") {
    return normalized;
  }
  return null;
}

export function normalizeResolvedResponseMode(value: unknown): ResolvedResponseMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "instant" || normalized === "thinking" ? normalized : null;
}

export function extractWordTokens(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function hasQuotedText(text: string): boolean {
  return /(^|\n)\s*>/.test(text) || /"/.test(text);
}

export function hasMultipleSentences(text: string): boolean {
  if (text.includes("\n")) return true;
  const matches = text.match(/[.!?]+/g);
  return Array.isArray(matches) && matches.length > 1;
}

export function isGreetingOrAck(text: string): boolean {
  const trimmed = (text || "").trim().toLowerCase();
  if (!trimmed) return false;
  const tokens = extractWordTokens(trimmed);
  if (!tokens.length) return false;
  if (trimmed.length > 20 && tokens.length > 3) return false;
  return tokens.every((token) => PHATIC_WORDS.has(token));
}

function parseSimpleArithmetic(text: string): { left: number; right: number; op: string } | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(SIMPLE_ARITHMETIC_REGEX);
  if (!match) return null;
  const [, leftRaw, op, rightRaw] = match;
  if (leftRaw == null || op == null || rightRaw == null) return null;
  const left = Number.parseFloat(leftRaw);
  const right = Number.parseFloat(rightRaw);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return { left, right, op };
}

export function isSimpleArithmetic(text: string): boolean {
  return Boolean(parseSimpleArithmetic(text));
}

function formatArithmeticResult(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value)) return String(value);
  const rounded = Math.round(value * 1e10) / 1e10;
  return String(rounded);
}

export function tryComputeArithmetic(text: string): { answer: string } | null {
  const parsed = parseSimpleArithmetic(text);
  if (!parsed) return null;
  const { left, right, op } = parsed;
  if (op === "/" && right === 0) return null;
  let result = 0;
  switch (op) {
    case "+":
      result = left + right;
      break;
    case "-":
      result = left - right;
      break;
    case "*":
      result = left * right;
      break;
    case "/":
      result = left / right;
      break;
    default:
      return null;
  }
  const answer = formatArithmeticResult(result);
  return answer ? { answer } : null;
}

export function resolveResponseMode(
  messageText: string,
  selectedMode: ResponseMode,
  context: {
    hasAttachments: boolean;
    hasSystemMessages: boolean;
    hasQuotedText: boolean;
    hasMultipleSentences: boolean;
    hasSimpleArithmetic: boolean;
  },
): ResolvedResponseMode {
  if (selectedMode === "instant") return "instant";
  if (selectedMode === "thinking") return "thinking";
  if (
    context.hasAttachments ||
    context.hasSystemMessages ||
    context.hasQuotedText ||
    context.hasMultipleSentences
  ) {
    return "thinking";
  }
  if (context.hasSimpleArithmetic) return "instant";
  if (isGreetingOrAck(messageText)) return "instant";
  return "thinking";
}
