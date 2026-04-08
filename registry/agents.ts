import { DEFAULT_TEXT_MODEL } from "../model_defaults";
import type { AgentCapability } from "../runtime/permission-context";
import type { RuntimePermissionMode } from "../services/runtime/permissions";

export interface AgentRegistryEntry {
  id: string;
  name: string;
  description: string;
  promptId: string;
  model?: string;
  capabilities: AgentCapability[];
  defaultBuckets?: string[];
  allowedBuckets?: string[];
  defaultPermissionMode?: RuntimePermissionMode;
  allowedRuntimeCapabilities?: AgentCapability[];
}

export const AGENT_REGISTRY: AgentRegistryEntry[] = [
  {
    id: "default",
    name: "Default OWEN",
    description: "General-purpose assistant.",
    promptId: "agent.default.system",
    capabilities: ["files", "web_search"],
    defaultBuckets: ["OWEN_UPLOADS"],
    allowedBuckets: ["OWEN_UPLOADS"],
    defaultPermissionMode: "read-only",
    allowedRuntimeCapabilities: ["files", "web_search"],
  },
  {
    id: "researcher",
    name: "Research Analyst",
    description: "Deep-dive analysis with extra emphasis on evidence and citations.",
    promptId: "agent.researcher.system",
    model: DEFAULT_TEXT_MODEL,
    capabilities: ["files", "web_search"],
    defaultBuckets: ["OWEN_UPLOADS"],
    allowedBuckets: ["OWEN_UPLOADS"],
    defaultPermissionMode: "read-only",
    allowedRuntimeCapabilities: ["files", "web_search"],
  },
];

export function getAgentRegistry(): AgentRegistryEntry[] {
  return AGENT_REGISTRY;
}
