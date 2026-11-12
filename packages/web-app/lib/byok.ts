import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export interface ByokSelection {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
}

export interface DirectModelFactories {
  anthropic(apiKey: string, model: string): LanguageModel;
  openai(apiKey: string, model: string): LanguageModel;
}

const directFactories: DirectModelFactories = {
  anthropic(apiKey, model) {
    return createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1" })(model);
  },
  openai(apiKey, model) {
    return createOpenAI({ apiKey, baseURL: "https://api.openai.com/v1" })(model);
  },
};

/** Keys are request-scoped: never stored, logged, forwarded to a gateway or retried with platform credentials. */
export function parseByok(body: unknown): ByokSelection | undefined {
  if (!body || typeof body !== "object" || !("byok" in body)) return undefined;
  const value = body.byok;
  if (!value || typeof value !== "object") throw new Error("Invalid BYOK configuration.");
  const fields = value as Record<string, unknown>;
  if (fields.provider !== "anthropic" && fields.provider !== "openai") {
    throw new Error("Choose Anthropic or OpenAI for BYOK.");
  }
  if (typeof fields.apiKey !== "string" || fields.apiKey.length < 8 || fields.apiKey.length > 512 || /\s/.test(fields.apiKey)) { // pragma: allowlist secret (validation or synthetic fixture)
    throw new Error("Enter a valid provider key.");
  }
  if (typeof fields.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(fields.model)) {
    throw new Error("Enter a provider model ID without a gateway prefix.");
  }
  if (Object.keys(fields).some((key) => !["provider", "apiKey", "model"].includes(key))) {
    throw new Error("Unsupported BYOK option.");
  }
  return { provider: fields.provider, apiKey: fields.apiKey, model: fields.model };
}

export function directLanguageModel(selection: ByokSelection, factories = directFactories): LanguageModel {
  if (selection.provider === "anthropic") return factories.anthropic(selection.apiKey, selection.model);
  return factories.openai(selection.apiKey, selection.model);
}
