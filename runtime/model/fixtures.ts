import type { ModelAdapterEndpoint, ModelAdapterFrame, ModelAdapterRequest } from "./adapter";

export type MockModelFixture = {
  key: string;
  endpoint: ModelAdapterEndpoint;
  labelExact?: string;
  labelIncludes?: string;
  payloadMetadataKey?: string;
  response: any;
  frames?: ModelAdapterFrame[];
};

export type MockModelFixtureCatalog = MockModelFixture[];

export const DEFAULT_MOCK_MODEL_FIXTURES: MockModelFixtureCatalog = [
  {
    key: "default-responses",
    endpoint: "responses",
    response: {
      output_text: ["Fixture response."],
      usage: { input_tokens: 12, output_tokens: 4 },
      status: "completed",
    },
  },
  {
    key: "default-chat-completions",
    endpoint: "chat_completions",
    response: {
      choices: [{ message: { content: "Fixture response." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    },
  },
];

export function resolveFixtureKey(request: ModelAdapterRequest): string | null {
  const metadata = request.payload.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const meta = metadata as Record<string, unknown>;
    const explicit = typeof meta.fixtureKey === "string"
      ? meta.fixtureKey
      : typeof meta.fixture_id === "string"
        ? meta.fixture_id
        : "";
    return explicit.trim() || null;
  }
  return null;
}

export function matchMockFixture(catalog: MockModelFixtureCatalog, request: ModelAdapterRequest): MockModelFixture {
  const explicitKey = resolveFixtureKey(request);
  if (explicitKey) {
    const keyed = catalog.find((fixture) => fixture.key === explicitKey);
    if (keyed) return keyed;
  }
  const exact = catalog.find((fixture) => fixture.endpoint === request.endpoint && fixture.labelExact === request.label);
  if (exact) return exact;
  const includes = catalog.find((fixture) => fixture.endpoint === request.endpoint && fixture.labelIncludes && request.label.includes(fixture.labelIncludes));
  if (includes) return includes;
  const fallback = catalog.find((fixture) => fixture.endpoint === request.endpoint);
  if (fallback) return fallback;
  throw new Error(`No mock fixture registered for ${request.endpoint}:${request.label}`);
}
