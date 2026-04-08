import { getAgentRegistry } from "../../registry/agents";
import { getPromptText } from "../../registry/prompts";
import type { AgentCapability } from "../../runtime/permission-context";
import type { RuntimePermissionMode } from "../runtime/permissions";

/**
 * Agent configuration primitives for the OWEN worker runtime.
 *
 * Used by: `src/index.ts` to choose system prompts, tool access, and model overrides.
 *
 * Key exports:
 * - `OwenTool`: Allowed tool capability labels for the model.
 * - `OwenAgent`: Shape of an agent preset (prompt + model + tooling).
 * - `AGENTS`: Registry of built-in agent presets keyed by id.
 *
 * Assumptions:
 * - Prompt text is treated as static content; do not embed secrets.
 * - Tool labels are mapped by the worker to actual tool wiring.
 */
export type OwenTool = AgentCapability;

/**
 * Describes a selectable agent preset (persona + model + tools) for chat requests.
 */
export interface OwenAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools: OwenTool[];
  defaultBuckets?: string[];
  allowedBuckets?: string[];
  defaultPermissionMode?: RuntimePermissionMode;
  allowedRuntimeCapabilities?: OwenTool[];
}

/**
 * Built-in OWEN agent presets keyed by id.
 */
export const AGENTS: Record<string, OwenAgent> = Object.fromEntries(
  getAgentRegistry().map((entry) => [
    entry.id,
    {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      systemPrompt: getPromptText(entry.promptId),
      model: entry.model,
      tools: entry.capabilities,
      defaultBuckets: entry.defaultBuckets,
      allowedBuckets: entry.allowedBuckets,
      defaultPermissionMode: entry.defaultPermissionMode,
      allowedRuntimeCapabilities: entry.allowedRuntimeCapabilities,
    } satisfies OwenAgent,
  ]),
);
