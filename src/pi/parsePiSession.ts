import type { ParsedPiSession, PiTurn } from './types';

interface PiContentBlock {
  type?: string;
  text?: string;
}

interface PiMessage {
  role?: string;
  content?: string | PiContentBlock[];
  timestamp?: number;
}

interface PiEntry {
  type?: string;
  version?: number;
  id?: string;
  cwd?: string;
  name?: string;
  timestamp?: string;
  message?: PiMessage;
}

function messageText(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function messageTimestamp(message: PiMessage, entry: PiEntry): number {
  if (typeof message.timestamp === 'number') return message.timestamp;
  const parsed = Date.parse(entry.timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parsePiSession(jsonl: string): ParsedPiSession {
  const parsed: ParsedPiSession = { version: null, id: null, cwd: null, name: null, turns: [] };
  let pendingAssistant: PiTurn | null = null;

  const flushAssistant = (): void => {
    if (pendingAssistant && pendingAssistant.text.trim()) parsed.turns.push(pendingAssistant);
    pendingAssistant = null;
  };

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;

    let entry: PiEntry;
    try {
      entry = JSON.parse(line) as PiEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'session') {
      parsed.version = typeof entry.version === 'number' ? entry.version : null;
      parsed.id = typeof entry.id === 'string' ? entry.id : null;
      parsed.cwd = typeof entry.cwd === 'string' ? entry.cwd : null;
      continue;
    }

    if (entry.type === 'session_info') {
      if (typeof entry.name === 'string') parsed.name = entry.name;
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;
    const { role } = entry.message;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = messageText(entry.message.content);
    if (!text.trim()) continue;

    if (role === 'user') {
      flushAssistant();
      parsed.turns.push({ role: 'user', text, timestampMs: messageTimestamp(entry.message, entry) });
    } else if (pendingAssistant) {
      pendingAssistant.text += text;
    } else {
      pendingAssistant = { role: 'assistant', text, timestampMs: messageTimestamp(entry.message, entry) };
    }
  }

  flushAssistant();
  return parsed;
}

export function sessionPreview(parsed: ParsedPiSession): string | null {
  for (let index = parsed.turns.length - 1; index >= 0; index -= 1) {
    const turn = parsed.turns[index];
    if (turn.role === 'assistant') return turn.text.trim().slice(0, 120);
  }
  return null;
}
