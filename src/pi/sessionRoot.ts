export const PI_SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR';

function joinHome(home: string, relative: string): string {
  const base = home.replace(/\/+$/, '');
  return base ? `${base}/${relative}` : `/${relative}`;
}

export function candidateSessionRoots(
  home: string,
  env: Record<string, string | undefined>,
  override?: string,
): string[] {
  const candidates = [
    override,
    env[PI_SESSION_DIR_ENV],
    joinHome(home, '.pi-agent/sessions'),
    joinHome(home, '.pi/agent/sessions'),
  ];

  const roots: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed || roots.includes(trimmed)) continue;
    roots.push(trimmed);
  }
  return roots;
}
