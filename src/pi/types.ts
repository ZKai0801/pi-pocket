export interface PiTurn {
  role: 'user' | 'assistant';
  text: string;
  timestampMs: number;
}

export interface ParsedPiSession {
  version: number | null;
  id: string | null;
  cwd: string | null;
  name: string | null;
  turns: PiTurn[];
}
