import type { ToolSpec } from "../permissions";

export const RUNTIME_TOOL_SPECS: Record<"files" | "web_search", ToolSpec> = {
  files: {
    toolId: "files",
    capability: "files",
    minimumPermissionMode: "read-only",
    bucketScoped: true,
    description: "Read OWEN-managed uploaded or indexed artifacts.",
  },
  web_search: {
    toolId: "web_search",
    capability: "web_search",
    minimumPermissionMode: "read-only",
    description: "Search the web for citations and current evidence.",
  },
};
