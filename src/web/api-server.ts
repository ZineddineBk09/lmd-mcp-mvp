import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import mongoose from "mongoose";
import { connectMongoDB } from "../connections/mongodb.js";
import { getOpenAITools, executeTool, getToolCount } from "./tool-registry.js";
import {
  saveConversation,
  loadConversation,
  listConversations,
  deleteConversation,
} from "./conversation-store.js";

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
    "No LLM API key found. Set CEREBRAS_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY in .env",
  );
}

let SYSTEM_PROMPT = "";
try {
  SYSTEM_PROMPT = readFileSync(
    resolve(__dirname, "..", "..", "system-prompt.txt"),
    "utf-8",
  );
} catch {
  SYSTEM_PROMPT =
    "You are Yassir LMD Ops Assistant. Answer questions using the available tools.";
}

function buildSystemPrompt(settings: {
  country_code?: string;
  dev_mode?: boolean;
}): string {
  let prompt = SYSTEM_PROMPT;

  if (settings.country_code && settings.country_code !== "ALL") {
    const names: Record<string, string> = {
      DZ: "Algeria",
      MA: "Morocco",
      TN: "Tunisia",
      FR: "France",
      ZA: "South Africa",
      SN: "Senegal",
    };
    prompt += `\n\nCONTEXT: The operator is focused on ${names[settings.country_code] || settings.country_code} (${settings.country_code}). Default to country_code="${settings.country_code}" for all queries unless they explicitly mention another country.`;
  }

  if (!settings.dev_mode) {
    prompt = prompt.replace(
      /6\. ALWAYS end your response with the MongoDB queries.*/,
      "6. Do NOT include MongoDB queries in your response.",
    );
  }

  return prompt;
}

const MAX_TOOL_ROUNDS = 12;

async function main() {
  await connectMongoDB();

  const provider = detectProvider();
  console.log(`[web] LLM provider: ${provider.name} (${provider.model})`);
  console.log(`[web] Tools loaded: ${getToolCount()}`);

  const openai = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
  });
  const tools = getOpenAITools();

  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
  app.use(express.json({ limit: "1mb" }));

  const chatLimiter = rateLimit({
    windowMs: 60_000,
    max: parseInt(process.env.RATE_LIMIT_RPM || "60", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  app.use("/api/chat", chatLimiter);

  const API_KEY = process.env.API_KEY;
  if (API_KEY) {
    app.use("/api/chat", (req, res, next) => {
      const provided =
        (req.headers["x-api-key"] as string | undefined) ??
        (req.query as Record<string, string>).api_key;
      if (provided !== API_KEY) {
        res
          .status(401)
          .json({ error: "Unauthorized. Provide a valid X-Api-Key header." });
        return;
      }
      next();
    });
    console.log("[web] API key authentication enabled for /api/chat");
  }

  const publicDir = resolve(__dirname, "..", "..", "public");
  app.use(
    express.static(publicDir, {
      etag: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    }),
  );

  app.get("/api/health", (_req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    res.status(dbReady ? 200 : 503).json({
      status: dbReady ? "ok" : "degraded",
      db: dbReady ? "connected" : "disconnected",
      provider: provider.name,
      model: provider.model,
      tools: getToolCount(),
    });
  });

  app.get("/api/conversations", (_req, res) => {
    res.json(listConversations());
  });

  app.get("/api/conversations/:id", (req, res) => {
    const conv = loadConversation(req.params.id);
    if (!conv) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json(conv);
  });

  app.post("/api/conversations/:id", (req, res) => {
    const { messages, settings } = req.body as {
      messages: Array<{ role: string; content: string }>;
      settings?: Record<string, unknown>;
    };
    saveConversation(req.params.id, messages, settings);
    res.json({ status: "saved" });
  });

  app.delete("/api/conversations/:id", (req, res) => {
    const deleted = deleteConversation(req.params.id);
    res.json({ status: deleted ? "deleted" : "not_found" });
  });

  app.post("/api/export", async (req, res) => {
    const { tool, params } = req.body as { tool: string; params: unknown };
    if (!tool) {
      res.status(400).json({ error: "tool is required" });
      return;
    }
    try {
      const { text: resultText } = await executeTool(tool, params ?? {});
      const parsed = JSON.parse(resultText);

      // Find the first array in the result to export
      let dataToExport: Record<string, unknown>[] = [];
      const findArray = (obj: unknown): Record<string, unknown>[] | null => {
        if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === "object")
          return obj;
        if (obj && typeof obj === "object") {
          for (const val of Object.values(obj as Record<string, unknown>)) {
            const found = findArray(val);
            if (found) return found;
          }
        }
        return null;
      };
      dataToExport = findArray(parsed) ?? [];

      if (dataToExport.length === 0) {
        res.status(400).json({ error: "No tabular data found in tool result" });
        return;
      }

      const { jsonToCsv } = await import("./csv-export.js");
      const csv = jsonToCsv(dataToExport);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${tool}_export.csv"`,
      );
      res.send(csv);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const {
      message,
      history = [],
      settings = {},
    } = req.body as {
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

    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    const SERVER_TIMEOUT_MS = 120_000;
    const timeout = setTimeout(() => {
      aborted = true;
    }, SERVER_TIMEOUT_MS);

    const send = (event: string, data: unknown) => {
      if (!aborted)
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
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      const requestStart = Date.now();

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (aborted) break;

        const response = await openai.chat.completions.create({
          model: provider.model,
          messages,
          tools,
          temperature: 0.1,
          max_tokens: 2048,
        });

        if (response.usage) {
          totalPromptTokens += response.usage.prompt_tokens ?? 0;
          totalCompletionTokens += response.usage.completion_tokens ?? 0;
        }

        if (aborted) break;

        const choice = response.choices[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        messages.push(assistantMsg);

        if (
          choice.finish_reason === "tool_calls" ||
          (assistantMsg.tool_calls?.length ?? 0) > 0
        ) {
          const calls = assistantMsg.tool_calls ?? [];
          for (const call of calls) {
            if (aborted) break;
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

            const { text: toolText, debugQuery } = await executeTool(
              fnName,
              fnArgs,
            );

            if (debugQuery) queriesCollected.push(debugQuery);

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: toolText,
            });

            send("tool_result", { name: fnName });
          }
          continue;
        }

        const text = assistantMsg.content ?? "";
        const elapsed = Date.now() - requestStart;
        const totalTokens = totalPromptTokens + totalCompletionTokens;
        console.log(
          `[llm] ${message.slice(0, 60)} | ${totalPromptTokens}+${totalCompletionTokens}=${totalTokens} tokens | ${toolsUsed.length} tools | ${elapsed}ms`,
        );

        send("content", { text });
        send("meta", {
          tools_used: toolsUsed,
          queries: queriesCollected,
          tokens: {
            prompt: totalPromptTokens,
            completion: totalCompletionTokens,
            total: totalTokens,
          },
          elapsed_ms: elapsed,
        });
        send("done", {});
        clearTimeout(timeout);
        res.end();
        return;
      }

      if (!aborted) {
        send("content", {
          text: "I reached the maximum number of tool calls. Here is what I found so far.",
        });
        const elapsed = Date.now() - requestStart;
        const totalTokens = totalPromptTokens + totalCompletionTokens;
        console.log(
          `[llm] ${message.slice(0, 60)} | ${totalPromptTokens}+${totalCompletionTokens}=${totalTokens} tokens (max rounds) | ${toolsUsed.length} tools | ${elapsed}ms`,
        );
        send("meta", {
          tools_used: toolsUsed,
          queries: queriesCollected,
          tokens: {
            prompt: totalPromptTokens,
            completion: totalCompletionTokens,
            total: totalTokens,
          },
          elapsed_ms: elapsed,
        });
        send("done", {});
      }
      clearTimeout(timeout);
      res.end();
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (!aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        send("error", { message: msg });
        res.end();
      }
    }
  });

  const PORT = parseInt(process.env.WEB_PORT || "3737", 10);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `[web] Yassir LMD Ops Copilot running at http://localhost:${PORT}`,
    );
    console.log(`[web] Share on local network: http://<your-ip>:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
