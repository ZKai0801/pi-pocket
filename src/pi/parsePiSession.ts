import type { ParsedPiSession, PiModelSwitch, PiTurn } from './types';

interface PiContentBlock {
  type?: string;
  text?: string;
}

function hasToolCall(content: string | PiContentBlock[] | undefined): boolean {
  return Array.isArray(content) && content.some((block) => block?.type === 'toolCall');
}

interface PiMessage {
  role?: string;
  content?: string | PiContentBlock[];
  timestamp?: number;
  /** The model that produced an assistant message, as pi names it. */
  model?: string;
  provider?: string;
}

interface PiEntry {
  type?: string;
  version?: number;
  id?: string;
  cwd?: string;
  name?: string;
  timestamp?: string;
  message?: PiMessage;
  /** `model_change`: the provider of the model the change selected. */
  provider?: string;
  /** `model_change`: the model id the change selected. */
  modelId?: string;
}

function messageText(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function messageTimestamp(message: PiMessage, entry: PiEntry): number {
  if (typeof message.timestamp === 'number') return message.timestamp;
  const parsed = Date.parse(entry.timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** An entry's own ISO timestamp; 0 when it carried none a reader can use. */
function entryTimestamp(entry: PiEntry): number {
  const parsed = Date.parse(entry.timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `provider/model`, or the lone id when the entry named no provider. */
function joinModel(provider: string | undefined, model: string | undefined): string | null {
  const id = typeof model === 'string' ? model.trim() : '';
  if (id === '') return null;
  const prefix = typeof provider === 'string' ? provider.trim() : '';
  return prefix === '' ? id : `${prefix}/${id}`;
}

export function parsePiSession(jsonl: string): ParsedPiSession {
  const parsed: ParsedPiSession = { version: null, id: null, cwd: null, name: null, turns: [] };
  const modelSwitches: PiModelSwitch[] = [];
  let pendingAssistant: PiTurn | null = null;
  // The last message entry of any role, for the settled test: a run is over
  // only when its final message is an assistant one with nothing left to run.
  // Every message entry updates this — user, assistant and toolResult alike —
  // because any of them as the tail means work is still owed.
  let tail: { role: string; toolCall: boolean } | null = null;
  // The model in effect as the file is walked: the last `model_change`'s
  // target, or — before the first of those — the model on the first assistant
  // message, which is the one the session began with. It is what the NEXT
  // `model_change` switched away from, and what the walk ends on: `parsed.model`.
  let currentModel: string | null = null;

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

    if (entry.type === 'model_change') {
      // The assistant turn the file had produced stands on its own from here:
      // the switch happened after it, which is where the divider belongs.
      flushAssistant();
      const to = joinModel(entry.provider, entry.modelId);
      // An entry that names no model is a record of nothing; dropping it keeps
      // a malformed line from becoming an empty divider.
      if (to !== null) {
        modelSwitches.push({
          to,
          from: currentModel,
          timestampMs: entryTimestamp(entry),
          afterTurns: parsed.turns.length,
        });
        currentModel = to;
      }
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;
    const { role } = entry.message;
    tail = { role: role ?? '', toolCall: hasToolCall(entry.message.content) };
    if (role !== 'user' && role !== 'assistant') continue;

    const text = messageText(entry.message.content);

    if (role === 'user') {
      flushAssistant();
      if (text.trim()) {
        parsed.turns.push({ role: 'user', text, timestampMs: messageTimestamp(entry.message, entry) });
      }
    } else {
      // The first assistant message that names its model says which model the
      // session began with — the only "from" a first switch can have. Later
      // ones are already covered by the `model_change` entries themselves.
      if (currentModel === null) {
        const model = joinModel(entry.message.provider, entry.message.model);
        if (model !== null) currentModel = model;
      }
      if (!text.trim()) continue;
      const timestampMs = messageTimestamp(entry.message, entry);
      if (pendingAssistant) {
        pendingAssistant.text += pendingAssistant.text ? `\n${text}` : text;
        pendingAssistant.timestampMs = timestampMs;
      } else {
        pendingAssistant = { role: 'assistant', text, timestampMs };
      }
    }
  }

  flushAssistant();
  parsed.modelSwitches = modelSwitches;
  parsed.model = currentModel;
  parsed.settled = tail !== null && tail.role === 'assistant' && !tail.toolCall;
  return parsed;
}

export function sessionPreview(parsed: ParsedPiSession): string | null {
  for (let index = parsed.turns.length - 1; index >= 0; index -= 1) {
    const turn = parsed.turns[index];
    if (turn.role === 'assistant') return turn.text.trim().slice(0, 120);
  }
  return null;
}
