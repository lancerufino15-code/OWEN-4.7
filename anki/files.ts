const ANKI_SNIFF_HEADER_BYTES = 16;

async function readFileHeaderBytes(file: File, length: number): Promise<Uint8Array> {
  const slice = file.slice(0, length);
  const ab = await slice.arrayBuffer();
  return new Uint8Array(ab);
}

function bytesMatch(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function isPdfSignature(bytes: Uint8Array): boolean {
  return bytesMatch(bytes, [0x25, 0x50, 0x44, 0x46]);
}

async function sniffPdfHeader(file: File): Promise<{ header: Uint8Array; isPdf: boolean }> {
  const header = await readFileHeaderBytes(file, ANKI_SNIFF_HEADER_BYTES);
  return { header, isPdf: isPdfSignature(header) };
}

function guessImageMimeTypeFromFilename(name: string): string {
  const lowered = (name || "").toLowerCase();
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) return "image/jpeg";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".gif")) return "image/gif";
  if (lowered.endsWith(".bmp")) return "image/bmp";
  if (lowered.endsWith(".tif") || lowered.endsWith(".tiff")) return "image/tiff";
  if (lowered.endsWith(".heic")) return "image/heic";
  return "";
}

export async function isAnkiPdfFile(file: File): Promise<boolean> {
  const { isPdf } = await sniffPdfHeader(file);
  return isPdf;
}

export function guessMimeTypeFromFilename(name: string): string {
  const lowered = (name || "").toLowerCase();
  if (lowered.endsWith(".pdf")) return "application/pdf";
  if (lowered.endsWith(".doc")) return "application/msword";
  if (lowered.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lowered.endsWith(".txt")) return "text/plain";
  if (lowered.endsWith(".csv")) return "text/csv";
  if (lowered.endsWith(".tsv")) return "text/tab-separated-values";
  const image = guessImageMimeTypeFromFilename(name);
  if (image) return image;
  return "application/octet-stream";
}
