import { describe, expect, it } from "vitest";

import { readAiConfiguration } from "../src/openai-summary.js";

describe("AI configuration", () => {
  it("uses DeepSeek defaults when only an API key is provided", () => {
    expect(readAiConfiguration({ AI_API_KEY: "test-key" })).toEqual({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      model: "deepseek-v4-flash",
    });
  });

  it("allows an explicit OpenAI-compatible endpoint and model override", () => {
    expect(
      readAiConfiguration({
        AI_API_KEY: "test-key",
        AI_BASE_URL: "https://example.com/v1/",
        AI_MODEL: "test-model",
      }),
    ).toEqual({
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      model: "test-model",
    });
  });
});
