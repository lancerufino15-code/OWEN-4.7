export function generateOpaqueId(prefix = "id"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${hex}`;
  }
  const random = Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
