import type { AgentCapability } from "../../../runtime/permission-context";

export type RuntimeToolId = Extract<AgentCapability, "files" | "web_search">;
export type ResponsesToolChoice = "auto" | "required";

type ResponsesToolPayload = { type: "web_search" };

const WEB_SEARCH_INCLUDE = "web_search_call.action.sources";

function uniqueToolIds(ids: Iterable<RuntimeToolId>): RuntimeToolId[] {
  return Array.from(new Set(ids));
}

export function buildResponsesTools(ids: Iterable<RuntimeToolId>): ResponsesToolPayload[] | undefined {
  const unique = uniqueToolIds(ids);
  if (!unique.includes("web_search")) return undefined;
  return [{ type: "web_search" }];
}

export function buildResponsesInclude(ids: Iterable<RuntimeToolId>): string[] | undefined {
  const unique = uniqueToolIds(ids);
  if (!unique.includes("web_search")) return undefined;
  return [WEB_SEARCH_INCLUDE];
}

export function buildResponsesToolConfig(
  ids: Iterable<RuntimeToolId>,
  toolChoice: ResponsesToolChoice,
): { tools?: ResponsesToolPayload[]; include?: string[]; tool_choice?: ResponsesToolChoice } {
  const tools = buildResponsesTools(ids);
  if (!tools?.length) return {};
  return {
    tools,
    include: buildResponsesInclude(ids),
    tool_choice: toolChoice,
  };
}
