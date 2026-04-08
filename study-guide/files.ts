const MACHINE_STUDY_GUIDE_PREFIX = "machine/study-guides";

function sanitizeMachineSlug(input: string, fallback: string): string {
  const cleaned = (input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

export function buildStudyGuideFilename(lectureTitle?: string): string {
  const title = lectureTitle?.trim() || "Lecture";
  return `Study_Guide_${title}.html`;
}

export function buildStudyGuideSourceFilename(lectureTitle?: string): string {
  const title = lectureTitle?.trim() || "Lecture";
  return `Study_Guide_${title}_Source.txt`;
}

export function buildStudyGuideStoredKey(docId?: string, lectureTitle?: string): string {
  const safeDocId = sanitizeMachineSlug(docId?.trim() || "", "doc");
  const title = lectureTitle?.trim() || "Lecture";
  const safeTitle = sanitizeMachineSlug(title, "lecture");
  return `${MACHINE_STUDY_GUIDE_PREFIX}/${safeDocId}/${safeTitle}/Study_Guide_${safeTitle}.html`;
}

export function buildStudyGuideSourceKey(docId?: string, lectureTitle?: string): string {
  const safeDocId = sanitizeMachineSlug(docId?.trim() || "", "doc");
  const title = lectureTitle?.trim() || "Lecture";
  const safeTitle = sanitizeMachineSlug(title, "lecture");
  return `${MACHINE_STUDY_GUIDE_PREFIX}/${safeDocId}/${safeTitle}/Study_Guide_${safeTitle}.txt`;
}
