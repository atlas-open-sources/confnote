import { describe, expect, it, vi } from "vitest";
import { directLanguageModel, parseByok } from "../lib/byok.js";
import type { LanguageModel } from "ai";

describe("request-scoped direct BYOK", () => {
  it.each(["openai", "anthropic"])("selects only the %s provider", (provider) => {
    const selection = parseByok({ byok: { provider, apiKey: "fixture-key-value", model: "fixture-model" } });
    if (!selection) throw new Error("missing selection");
    const model = "fixture-model" as LanguageModel;
    const factories = { openai: vi.fn(() => model), anthropic: vi.fn(() => model) };
    expect(directLanguageModel(selection, factories)).toBe(model);
    expect(factories[selection.provider]).toHaveBeenCalledWith("fixture-key-value", "fixture-model");
    expect(factories[selection.provider === "openai" ? "anthropic" : "openai"]).not.toHaveBeenCalled();
  });

  it("does not fall back when a user's provider fails", () => {
    const factories = {
      openai: vi.fn(() => { throw new Error("key rejected"); }),
      anthropic: vi.fn(),
    };
    expect(() => directLanguageModel({ provider: "openai", apiKey: "fixture-key-value", model: "fixture" }, factories)).toThrow("key rejected"); // pragma: allowlist secret (validation or synthetic fixture)
    expect(factories.anthropic).not.toHaveBeenCalled();
  });

  it("rejects custom endpoints and gateway model IDs", () => {
    expect(() => parseByok({ byok: { provider: "openai", apiKey: "fixture-key-value", model: "openai/gpt", baseURL: "https://attacker.test" } })).toThrow(); // pragma: allowlist secret (synthetic fixture)
    expect(() => parseByok({ byok: null })).toThrow();
    expect(parseByok({ messages: [] })).toBeUndefined();
  });
});
