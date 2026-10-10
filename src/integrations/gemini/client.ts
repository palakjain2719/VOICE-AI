import "server-only";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { requireEnv } from "@/lib/env";

export interface GeminiUsage {
  model: string;
  promptTokens: number;
  outputTokens: number;
}

export interface JsonModel {
  generateJson<T>(opts: { system: string; prompt: string; schema: z.ZodType<T>; maxOutputTokens?: number; thinking?: "low" }): Promise<{ data: T; usage: GeminiUsage }>;
  generateText(opts: { system: string; prompt: string; maxOutputTokens?: number }): Promise<{ text: string; usage: GeminiUsage }>;
}

let client: GoogleGenAI | null = null;

/**
 * Gemini via the official @google/genai SDK (models.generateContent). Structured output uses
 * `responseMimeType: application/json` + `responseJsonSchema`, and every response is still
 * validated with Zod before use.
 */
export function gemini(): JsonModel {
  const { GEMINI_API_KEY, GEMINI_MODEL } = requireEnv("gemini", ["GEMINI_API_KEY", "GEMINI_MODEL"]);
  client ??= new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const ai = client;

  const usageOf = (r: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } }): GeminiUsage => ({
    model: GEMINI_MODEL,
    promptTokens: r.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0),
  });

  return {
    async generateJson({ system, prompt, schema, maxOutputTokens = 8192 }) {
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
          maxOutputTokens,
          // Thinking tokens count against maxOutputTokens; keep them small for extraction tasks.
          // gemini-3.8-flash rejects MINIMAL, so LOW is the floor.
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      const text = res.text;
      if (!text) throw new Error("Gemini returned no content");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Gemini returned malformed JSON");
      }
      return { data: schema.parse(parsed), usage: usageOf(res) };
    },
    async generateText({ system, prompt, maxOutputTokens = 1024 }) {
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: { systemInstruction: system, maxOutputTokens, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
      });
      return { text: res.text ?? "", usage: usageOf(res) };
    },
  };
}
