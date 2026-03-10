import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import mongoose from 'mongoose';
import { connectMongoDB } from '../connections/mongodb.js';
import { getOpenAITools, executeTool, getToolCount, getFilteredToolCount } from './tool-registry.js';
import type { AuthContext } from '../auth/types.js';
import { HttpClient } from '../api/http-client.js';
import { fetchCurrentUser, clearAuthCache } from '../api/auth.api.js';
import { initHttpClient } from '../api/http-client.js';
import { isWriteTool } from '../auth/safety-tiers.js';
import { logTool, getRecentToolLogs } from '../utils/tool-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '..', '..', '.env') });

interface LLMProvider {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

function detectProvider(): LLMProvider {
  if (process.env.CEREBRAS_API_KEY) {
    return {
      name: 'Cerebras',
      apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: 'https://api.cerebras.ai/v1',
      model: process.env.OPENAI_MODEL || 'qwen-3-32b',
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      name: 'Gemini',
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      model: process.env.OPENAI_MODEL || 'gemini-2.5-flash',
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      name: 'Groq',
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
      model: process.env.OPENAI_MODEL || 'llama-3.3-70b-versatile',
    };
  }
  if (process.env.QWEN_API_KEY) {
    return {
      name: 'Qwen (DashScope)',
      apiKey: process.env.QWEN_API_KEY,
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      model: process.env.QWEN_MODEL || 'qwen-plus',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      name: 'OpenAI',
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }
  throw new Error('No LLM API key found. Set CEREBRAS_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, QWEN_API_KEY, or OPENAI_API_KEY in .env');
}

let SYSTEM_PROMPT = '';
try {
  SYSTEM_PROMPT = readFileSync(resolve(__dirname, '..', '..', 'system-prompt.txt'), 'utf-8');
} catch {
  SYSTEM_PROMPT = 'You are Yassir LMD Ops Assistant. Answer questions using the available tools.';
}

function buildSystemPrompt(settings: { country_code?: string; dev_mode?: boolean; username?: string }): string {
  let prompt = SYSTEM_PROMPT;

  if (settings.country_code && settings.country_code !== 'ALL') {
    const names: Record<string, string> = {
      DZ: 'Algeria',
      MA: 'Morocco',
      TN: 'Tunisia',
      FR: 'France',
      ZA: 'South Africa',
      SN: 'Senegal',
    };
    prompt += `\n\nCONTEXT: The operator is focused on ${names[settings.country_code] || settings.country_code} (${settings.country_code}). Default to country_code="${settings.country_code}" for all queries unless they explicitly mention another country.`;
  }

  if (settings.username) {
    prompt += `\n\nOPERATOR: Logged in as "${settings.username}". Use this for audit trails in write operations.`;
  }

  return prompt;
}

const MAX_TOOL_ROUNDS = 12;

const stats = {
  visitors: new Set<string>(),
  chatRequests: 0,
  startedAt: new Date().toISOString(),
};

async function resolveAuthContext(req: express.Request): Promise<AuthContext | undefined> {
  const authHeader = (req.headers.authorization as string | undefined) ?? (req.headers['x-auth-token'] as string | undefined) ?? process.env.YASSIR_AUTH_TOKEN;

  const baseURL = process.env.YASSIR_API_BASE_URL;
  if (!authHeader || !baseURL) return undefined;

  const headerCountry = req.headers['country-code'] as string | undefined;
  const bodySettings = (req.body as { settings?: { country_code?: string } })?.settings;
  const countryCode: string = headerCountry ?? bodySettings?.country_code ?? process.env.YASSIR_COUNTRY_CODE ?? 'DZ';

  try {
    const client = new HttpClient({
      baseURL,
      token: authHeader,
      countryCode,
      iapCookie: process.env.YASSIR_IAP_COOKIE || undefined,
    });
    return await fetchCurrentUser(client, authHeader, countryCode);
  } catch (err) {
    console.warn('[web] Auth resolution failed:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

async function main() {
  await connectMongoDB();

  const provider = detectProvider();
  console.log(`[web] LLM provider: ${provider.name} (${provider.model})`);
  console.log(`[web] Tools loaded: ${getToolCount()}`);

  const apiBaseURL = process.env.YASSIR_API_BASE_URL;
  if (apiBaseURL) {
    initHttpClient({
      baseURL: apiBaseURL,
      token: process.env.YASSIR_AUTH_TOKEN ?? '',
      countryCode: process.env.YASSIR_COUNTRY_CODE ?? 'DZ',
      iapCookie: process.env.YASSIR_IAP_COOKIE || undefined,
    });
    console.log(`[web] API client initialized: ${apiBaseURL}`);
    if (process.env.YASSIR_IAP_COOKIE) {
      console.log('[web] IAP cookie configured for preprod access');
    } else {
      console.warn('[web] No YASSIR_IAP_COOKIE set — API calls to IAP-protected environments will fail');
    }
  }

  const openai = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
  });

  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
  app.use(express.json({ limit: '1mb' }));

  const chatLimiter = rateLimit({
    windowMs: 60_000,
    max: parseInt(process.env.RATE_LIMIT_RPM || '60', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use('/api/chat', chatLimiter);

  const API_KEY = process.env.API_KEY;
  if (API_KEY) {
    const apiKeyGuard = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const provided = (req.headers['x-api-key'] as string | undefined) ?? (req.query as Record<string, string>).api_key;
      if (provided !== API_KEY) {
        res.status(401).json({ error: 'Unauthorized. Provide a valid X-Api-Key header.' });
        return;
      }
      next();
    };
    app.use('/api/chat', apiKeyGuard);
    app.use('/api/export', apiKeyGuard);
    console.log('[web] API key authentication enabled for /api/chat, /api/export');
  }

  const publicDir = resolve(__dirname, '..', '..', 'public');
  app.use(
    express.static(publicDir, {
      etag: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store');
        }
      },
    }),
  );

  app.get('/api/health', (_req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    const hasEnvToken = Boolean(process.env.YASSIR_AUTH_TOKEN);
    res.status(dbReady ? 200 : 503).json({
      status: dbReady ? 'ok' : 'degraded',
      db: dbReady ? 'connected' : 'disconnected',
      provider: provider.name,
      model: provider.model,
      tools: getToolCount(),
      api_layer: apiBaseURL ? 'enabled' : 'disabled',
      auth: hasEnvToken ? 'configured' : 'not_configured',
    });
  });

  app.post('/api/export', async (req, res) => {
    const { tool, params } = req.body as { tool: string; params: unknown };
    if (!tool) {
      res.status(400).json({ error: 'tool is required' });
      return;
    }
    try {
      const authCtx = await resolveAuthContext(req);
      const { text: resultText } = await executeTool(tool, params ?? {}, authCtx);
      const parsed = JSON.parse(resultText);

      let dataToExport: Record<string, unknown>[] = [];
      const findArray = (obj: unknown): Record<string, unknown>[] | null => {
        if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') return obj;
        if (obj && typeof obj === 'object') {
          for (const val of Object.values(obj as Record<string, unknown>)) {
            const found = findArray(val);
            if (found) return found;
          }
        }
        return null;
      };
      dataToExport = findArray(parsed) ?? [];

      if (dataToExport.length === 0) {
        res.status(400).json({ error: 'No tabular data found in tool result' });
        return;
      }

      const { jsonToCsv } = await import('./csv-export.js');
      const csv = jsonToCsv(dataToExport);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${tool}_export.csv"`);
      res.send(csv);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/stats', (_req, res) => {
    res.json({
      unique_users: stats.visitors.size,
      total_chats: stats.chatRequests,
      started_at: stats.startedAt,
    });
  });

  app.get('/api/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const phase = req.query.phase as string | undefined;
    let logs = getRecentToolLogs(limit);
    if (phase) {
      logs = logs.filter((l) => l.phase === phase);
    }
    res.json({ count: logs.length, logs });
  });

  app.post('/api/chat', async (req, res) => {
    stats.visitors.add(req.ip || req.socket.remoteAddress || 'unknown');
    stats.chatRequests++;

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
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });

    const SERVER_TIMEOUT_MS = 120_000;
    const timeout = setTimeout(() => {
      aborted = true;
    }, SERVER_TIMEOUT_MS);

    const send = (event: string, data: unknown) => {
      if (!aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const authCtx = await resolveAuthContext(req);

      const tools = getOpenAITools(authCtx?.privileges, authCtx?.role);
      const filteredCount = tools.length;

      const systemPrompt = buildSystemPrompt({
        ...settings,
        username: authCtx?.username,
      });

      if (authCtx) {
        send('auth', {
          username: authCtx.username,
          role: authCtx.role,
          country: authCtx.countryCode,
          tools_available: filteredCount,
          tools_total: getToolCount(),
        });
      }

      const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, ...history.slice(-20), { role: 'user', content: message }];

      const toolsUsed: Array<{
        name: string;
        args: unknown;
        isWrite?: boolean;
      }> = [];
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

        if (choice.finish_reason === 'tool_calls' || (assistantMsg.tool_calls?.length ?? 0) > 0) {
          const calls = assistantMsg.tool_calls ?? [];

          const hasWrites = calls.some((c) => c.type === 'function' && isWriteTool(c.function.name));

          if (hasWrites) {
            for (const call of calls) {
              if (aborted) break;
              if (call.type !== 'function') continue;
              const result = await executeToolCall(call, authCtx, send, toolsUsed, queriesCollected);
              messages.push(result);
            }
          } else {
            const results = await Promise.all(calls.filter((c) => c.type === 'function').map((call) => executeToolCall(call, authCtx, send, toolsUsed, queriesCollected)));
            messages.push(...results);
          }
          continue;
        }

        const text = assistantMsg.content ?? '';
        const elapsed = Date.now() - requestStart;
        const totalTokens = totalPromptTokens + totalCompletionTokens;
        console.log(`[llm] ${message.slice(0, 60)} | ${totalPromptTokens}+${totalCompletionTokens}=${totalTokens} tokens | ${toolsUsed.length} tools | ${elapsed}ms`);

        send('content', { text });
        send('meta', {
          tools_used: toolsUsed,
          queries: queriesCollected,
          tokens: {
            prompt: totalPromptTokens,
            completion: totalCompletionTokens,
            total: totalTokens,
          },
          elapsed_ms: elapsed,
          auth: authCtx ? { username: authCtx.username, role: authCtx.role } : null,
        });
        send('done', {});
        clearTimeout(timeout);
        res.end();
        return;
      }

      if (!aborted) {
        send('content', {
          text: 'I reached the maximum number of tool calls. Here is what I found so far.',
        });
        const elapsed = Date.now() - requestStart;
        const totalTokens = totalPromptTokens + totalCompletionTokens;
        console.log(`[llm] ${message.slice(0, 60)} | ${totalPromptTokens}+${totalCompletionTokens}=${totalTokens} tokens (max rounds) | ${toolsUsed.length} tools | ${elapsed}ms`);
        send('meta', {
          tools_used: toolsUsed,
          queries: queriesCollected,
          tokens: {
            prompt: totalPromptTokens,
            completion: totalCompletionTokens,
            total: totalTokens,
          },
          elapsed_ms: elapsed,
        });
        send('done', {});
      }
      clearTimeout(timeout);
      res.end();
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (!aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        send('error', { message: msg });
        res.end();
      }
    }
  });

  const PORT = parseInt(process.env.PORT || process.env.WEB_PORT || '3737', 10);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[web] Yassir LMD Ops Copilot running at http://localhost:${PORT}`);
    console.log(`[web] Share on local network: http://<your-ip>:${PORT}`);

    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
      const PING_INTERVAL_MS = 10 * 60 * 1000;
      setInterval(async () => {
        try {
          const r = await fetch(`${RENDER_URL}/api/health`);
          console.log(`[keep-alive] pinged ${RENDER_URL}/api/health → ${r.status}`);
        } catch (e) {
          console.warn('[keep-alive] ping failed:', (e as Error).message);
        }
      }, PING_INTERVAL_MS);
      console.log('[keep-alive] self-ping enabled (every 10 min)');
    }
  });
}

async function executeToolCall(
  call: { id: string; function: { name: string; arguments: string } },
  authCtx: AuthContext | undefined,
  send: (event: string, data: unknown) => void,
  toolsUsed: Array<{ name: string; args: unknown; isWrite?: boolean }>,
  queriesCollected: string[],
): Promise<ChatCompletionMessageParam> {
  const fnName = call.function.name;
  let fnArgs: unknown;
  try {
    fnArgs = JSON.parse(call.function.arguments);
  } catch {
    fnArgs = {};
  }

  logTool({
    phase: 'llm_request',
    tool: fnName,
    args: fnArgs,
    meta: { raw_arguments: call.function.arguments, auth_user: authCtx?.username },
  });

  const isWrite = isWriteTool(fnName);
  send('tool_call', { name: fnName, args: fnArgs, isWrite });
  toolsUsed.push({ name: fnName, args: fnArgs, isWrite });

  const callStart = Date.now();
  const { text: toolText, debugQuery } = await executeTool(fnName, fnArgs, authCtx);

  if (debugQuery) queriesCollected.push(debugQuery);

  logTool({
    phase: 'llm_response',
    tool: fnName,
    result: toolText,
    duration_ms: Date.now() - callStart,
    meta: { text_length: toolText.length, debugQuery },
  });

  // Detect confirmation-required tool results and send structured event to frontend
  try {
    const parsed = JSON.parse(toolText);
    const resultObj = parsed?.result ?? parsed;
    if (resultObj?.requires_confirmation && isWrite) {
      send('confirmation_needed', {
        tool: fnName,
        args: fnArgs,
        preview: resultObj.preview ?? null,
        available_reasons: resultObj.preview?.available_reasons ?? resultObj.available_reasons ?? null,
        instruction: resultObj.instruction ?? null,
        requires_refund: resultObj.preview?.requires_refund ?? false,
      });
    }
  } catch {
    // Non-JSON tool result — no confirmation detection
  }

  send('tool_result', { name: fnName, isWrite });

  return {
    role: 'tool' as const,
    tool_call_id: call.id,
    content: toolText,
  };
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
