import type { VisionMode } from "./types";

function buildSharedVisionGuidance(userText: string): string[] {
  const lines = [
    "Use the attached image content as primary evidence for your answer.",
    "Separate direct visual observations from higher-level interpretation.",
    "State uncertainty explicitly when image quality, magnification, stain, or coverage is insufficient.",
    "Do not claim a definitive diagnosis unless the image alone clearly supports it.",
  ];
  if (/\b(compare|comparison|differentiate|difference|versus|vs\.?)\b/i.test(userText)) {
    lines.push("If multiple images are present, compare them directly and call out the most important similarities and differences.");
  }
  return lines;
}

export function normalizeVisionMode(value: unknown): VisionMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "auto" || value === "general" || value === "pathology" || value === "histology" || value === "ocr") {
    return value;
  }
  return undefined;
}

export function inferVisionMode(userText: string, explicitMode: VisionMode = "auto"): VisionMode {
  if (explicitMode !== "auto") return explicitMode;
  const lowered = (userText || "").toLowerCase();
  if (/\bhistolog(?:y|ic)\b|\bhematoxylin\b|\beosin\b|\bh&e\b|\bepithelium\b|\bstroma\b/.test(lowered)) {
    return "histology";
  }
  if (/\bpatholog(?:y|ic)\b|\bbiopsy\b|\bcytolog(?:y|ic)\b|\btumou?r\b|\bneoplasm\b|\blesion\b|\bstain\b/.test(lowered)) {
    return "pathology";
  }
  return "general";
}

export function buildVisionSystemPrompt(baseSystemPrompt: string, mode: VisionMode, userText: string): string {
  const shared = buildSharedVisionGuidance(userText);

  const modeSpecific = (() => {
    switch (mode) {
      case "pathology":
        return [
          "Describe tissue architecture, morphology, and cytologic features before offering interpretation.",
          "Identify salient abnormalities and explain what is visible versus what is inferred.",
          "Frame pathology reasoning as educational differential thinking, not a definitive diagnosis.",
          "Mention likely stain, magnification, or sampling limits when they affect confidence.",
        ];
      case "histology":
        return [
          "Identify the most likely tissue type, layer, or structure when the image supports it.",
          "Explain normal versus abnormal histologic features in teaching-oriented language.",
          "Discuss staining patterns only when they are visually supported or strongly implied by the image.",
          "Call out uncertainty when tissue orientation, stain, or magnification is insufficient.",
        ];
      case "ocr":
        return [
          "Prioritize verbatim transcription of visible text.",
          "Preserve numbers, abbreviations, and layout cues when they materially affect meaning.",
          "Only describe non-text visual structure when it helps explain the transcription.",
        ];
      case "general":
      case "auto":
      default:
        return [
          "Describe the visible content clearly before drawing conclusions.",
          "Identify relevant structures, objects, diagrams, or labels.",
          "Extract visible text when it is relevant to the answer.",
          "Note uncertainty instead of guessing when the image is ambiguous.",
        ];
    }
  })();

  return [baseSystemPrompt.trim(), "Vision-specific guidance:", ...shared, ...modeSpecific]
    .filter(Boolean)
    .join("\n");
}
