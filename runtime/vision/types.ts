export type VisionMode = "auto" | "general" | "pathology" | "histology" | "ocr";

export type VisionChatRole = "system" | "user" | "assistant";
export type VisionImageDetail = "low" | "high" | "auto";
export type VisionImageSource = "upload" | "paste" | "url";

export type VisionTextPart = { type: "text"; text: string };

export type VisionImagePart = {
  type: "image";
  label?: string;
  mimeType?: string;
  detail?: VisionImageDetail;
  dataUrl?: string;
  imageUrl?: string;
  fileId?: string;
  visionFileId?: string;
  source?: VisionImageSource;
};

export type VisionChatContentPart = VisionTextPart | VisionImagePart;

export type VisionChatMessage = {
  role: VisionChatRole;
  content: string | VisionChatContentPart[];
};
