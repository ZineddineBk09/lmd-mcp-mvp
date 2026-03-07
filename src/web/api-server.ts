import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import express from "express";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { connectMongoDB } from "../connections/mongodb.js";
import { getOpenAITools, executeTool, getToolCount } from "./tool-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "..", "..", ".env") });

interface LLMProvider {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

function detectProvider(): LLMProvider {
  if (process.env.CEREBRAS_API_KEY) {
    return {
      name: "Cerebras",
      apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: "https://api.cerebras.ai/v1",
      model: process.env.OPENAI_MODEL || "qwen-3-32b",
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      name: "Gemini",
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: process.env.OPENAI_MODEL || "gemini-2.0-flash",
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      name: "Groq",
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      model: process.env.OPENAI_MODEL || "llama-3.3-70b-versatile",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "OpenAI",
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: "https://api.openai.com/v1",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }
  throw new Error(
    "No LLM API key found. Set CEREBRAS_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY in .env"
  );
}

let SYSTEM_PROMPT = "";
try {
  SYSTEM_PROMPT = readFileSync(
    resolve(__dirname, "..", "..", "system-prompt.txt"),
    "utf-8"
  );
} catch {
  SYSTEM_PROMPT = "You are Yassir LMD Ops Assistant. Answer questions using the available tools.";
}

function buildSystemPrompt(settings: { country_code?: string; dev_mode?: boolean }): string {
  let prompt = SYSTEM_PROMPT;

  if (settings.country_code && settings.country_code !== "ALL") {
    const names: Record<string, string> = { DZ: "Algeria", MA: "Morocco", TN: "Tunisia", CI: "Ivory Coast" };
    prompt += `\n\nCONTEXT: The operator is focused on ${names[settings.country_code] || settings.country_code} (${settings.country_code}). Default to country_code="${settings.country_code}" for all queries unless they explicitly mention another country.`;
  }

  if (!settings.dev_mode) {
    prompt = prompt.replace(
      /6\. ALWAYS end your response with the MongoDB queries.*/,
      "6. Do NOT include MongoDB queries in your response."
    );
  }

  return prompt;
}

const MAX_TOOL_ROUNDS = 8;

async function main() {
  await connectMongoDB();

  const provider = detectProvider();
  console.log(`[web] LLM provider: ${provider.name} (${provider.model})`);
  console.log(`[web] Tools loaded: ${getToolCount()}`);

  const openai = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  const tools = getOpenAITools();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const publicDir = resolve(__dirname, "..", "..", "public");
  app.use(express.static(publicDir));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", provider: provider.name, model: provider.model, tools: getToolCount() });
  });

  app.post("/api/chat", async (req, res) => {
    const { message, history = [], settings = {} } = req.body as {
      message: string;
      history: ChatCompletionMessageParam[];
      settings: { country_code?: string; dev_mode?: boolean };
    };

    if (!message?.trim()) {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const systemPrompt = buildSystemPrompt(settings);

      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...history.slice(-20),
        { role: "user", content: message },
      ];

      const toolsUsed: Array<{ name: string; args: unknown }> = [];
      const queriesCollected: string[] = [];

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await openai.chat.completions.create({
          model: provider.model,
          messages,
          tools,
          temperature: 0.1,
          max_tokens: 2048,
        });

        const choice = response.choices[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        messages.push(assistantMsg);

        if (choice.finish_reason === "tool_calls" || (assistantMsg.tool_calls?.length ?? 0) > 0) {
          const calls = assistantMsg.tool_calls ?? [];
          for (const call of calls) {
            if (call.type !== "function") continue;
            const fnName = call.function.name;
            let fnArgs: unknown;
            try {
              fnArgs = JSON.parse(call.function.arguments);
            } catch {
              fnArgs = {};
            }

            send("tool_call", { name: fnName, args: fnArgs });
            toolsUsed.push({ name: fnName, args: fnArgs });

            const result = await executeTool(fnName, fnArgs);

            try {
              const parsed = JSON.parse(result);
              if (parsed?._debug?.query) queriesCollected.push(parsed._debug.query);
              if (parsed?.result?._debug?.query) queriesCollected.push(parsed.result._debug.query);
            } catch { /* not json, skip */ }

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            });

            send("tool_result", { name: fnName });
          }
          continue;
        }

        const text = assistantMsg.content ?? "";
        send("content", { text });
        send("meta", { tools_used: toolsUsed, queries: queriesCollected });
        send("done", {});
        res.end();
        return;
      }

      send("content", { text: "I reached the maximum number of tool calls. Here is what I found so far." });
      send("meta", { tools_used: toolsUsed, queries: queriesCollected });
      send("done", {});
      res.end();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      send("error", { message: msg });
      res.end();
    }
  });

  const PORT = parseInt(process.env.WEB_PORT || "3737", 10);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[web] Yassir LMD Ops Copilot running at http://localhost:${PORT}`);
    console.log(`[web] Share on local network: http://<your-ip>:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
