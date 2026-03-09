import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STORE_DIR = resolve(__dirname, '..', '..', 'data', 'conversations');

export interface ConversationEntry {
  id: string;
  created_at: string;
  updated_at: string;
  messages: Array<{ role: string; content: string; timestamp: string }>;
  settings?: Record<string, unknown>;
}

function ensureDir() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

export function saveConversation(id: string, messages: Array<{ role: string; content: string }>, settings?: Record<string, unknown>): void {
  ensureDir();
  const filePath = resolve(STORE_DIR, `${id}.json`);
  const now = new Date().toISOString();
  let entry: ConversationEntry;

  if (existsSync(filePath)) {
    entry = JSON.parse(readFileSync(filePath, 'utf-8'));
    entry.updated_at = now;
    entry.messages = messages.map((m) => ({ ...m, timestamp: now }));
  } else {
    entry = {
      id,
      created_at: now,
      updated_at: now,
      messages: messages.map((m) => ({ ...m, timestamp: now })),
      settings,
    };
  }

  writeFileSync(filePath, JSON.stringify(entry, null, 2));
}

export function loadConversation(id: string): ConversationEntry | null {
  const filePath = resolve(STORE_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function listConversations(): Array<{
  id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}> {
  ensureDir();
  const files = readdirSync(STORE_DIR).filter((f) => f.endsWith('.json'));
  return files
    .map((f) => {
      const data = JSON.parse(readFileSync(resolve(STORE_DIR, f), 'utf-8')) as ConversationEntry;
      return {
        id: data.id,
        created_at: data.created_at,
        updated_at: data.updated_at,
        message_count: data.messages.length,
      };
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function deleteConversation(id: string): boolean {
  const filePath = resolve(STORE_DIR, `${id}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}
