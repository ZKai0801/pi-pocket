/**
 * The Android host source: the phone's answer to desktop's `~/.ssh/config`
 * and web's synced account list, behind the shared picker's
 * `ssh.listConfigHosts` and the adapter's credential resolution.
 *
 * Two kinds of host appear:
 *  - hosts imported from the signed 0.5.x app (`readImportedLegacyHosts`),
 *    dialled with the native key handle their key was imported under;
 *  - hosts added on this phone, saved with the handle of a key in the
 *    Android key vault (#2926). Secret material never enters the WebView: a
 *    host names either a key handle or an opaque password-credential id, and
 *    the native plugin resolves the secret at dial time.
 */
import type { HostEntry, SshCredential, SshHostTarget } from '@pocketshell/core';
import { makeLegacySshHostTarget } from '@/migration/legacySshTarget';
import type { ImportedLegacyHost } from '@/migration/installedDataMigration';

export const ANDROID_HOSTS_STORAGE_KEY = 'pocketshell.android.hosts.v1';

/** How a saved host authenticates. Only opaque ids ever reach storage. */
export type HostAuth =
  | {
    kind: 'key';
    keyHandleId: string;
    /** User asked for the passphrase to survive the process (Plan 4). */
    rememberPassphrase?: boolean;
    /** The sealed secret this host's remembered passphrase lives under. */
    secretId?: string;
  }
  | { kind: 'password'; passwordCredentialId: string };

export interface SavedHost {
  name: string;
  hostname: string;
  port: number;
  user: string;
  /** The Android key vault handle this host authenticates with (#2926). */
  keyHandleId: string;
  /**
   * Explicit auth kind. Absent on a v1 record, which already is a key host
   * (its `keyHandleId` names the key). A password host carries an opaque
   * credential id resolved by the native plugin — never a password.
   */
  auth?: HostAuth;
  /** Where this host's pi agent keeps its sessions, if overridden. */
  piSessionsDir?: string;
  /** The pi executable to run on this host, if overridden. */
  piCommand?: string;
}

export interface StringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AndroidHostStoreOptions {
  storage: StringStorage;
  /** Hosts carried over from the 0.5.x app; empty off-device or before import. */
  readLegacyHosts: () => Promise<ImportedLegacyHost[]>;
}

/** Why a host cannot be dialled right now, in words the picker can show. */
export class MissingHostCredential extends Error {
  /** The saved host with no key, so a prompt can attach one to it in place. */
  readonly host: HostEntry;

  constructor(host: Omit<SavedHost, 'keyHandleId'>) {
    super(`No SSH key is chosen for “${host.name}” — add the host again with a key from the key vault.`);
    this.name = 'MissingHostCredential';
    this.host = toEntry(host);
  }
}

function toEntry(host: Omit<SavedHost, 'keyHandleId'>): HostEntry {
  return {
    name: host.name,
    hostname: host.hostname,
    port: host.port,
    user: host.user,
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
  };
}

function isHostAuth(value: unknown): value is HostAuth {
  if (typeof value !== 'object' || value === null) return false;
  const auth = value as Record<string, unknown>;
  if (auth.kind === 'key') {
    return typeof auth.keyHandleId === 'string'
      && (auth.rememberPassphrase === undefined || typeof auth.rememberPassphrase === 'boolean')
      && (auth.secretId === undefined || (typeof auth.secretId === 'string' && auth.secretId.length > 0));
  }
  if (auth.kind === 'password') return typeof auth.passwordCredentialId === 'string';
  return false;
}

function isSavedHost(value: unknown): value is SavedHost {
  if (typeof value !== 'object' || value === null) return false;
  const host = value as Record<string, unknown>;
  return typeof host.name === 'string' && host.name.length > 0
    && typeof host.hostname === 'string' && host.hostname.length > 0
    && typeof host.user === 'string'
    && typeof host.port === 'number' && Number.isInteger(host.port) && host.port > 0 && host.port < 65536
    && (host.keyHandleId === undefined || typeof host.keyHandleId === 'string')
    && (host.auth === undefined || isHostAuth(host.auth))
    && (host.piSessionsDir === undefined || typeof host.piSessionsDir === 'string')
    && (host.piCommand === undefined || typeof host.piCommand === 'string');
}

/**
 * The one field a saved host is missing or has wrong, named rather than
 * worded, so a shell can render it in its own language (R35). The wrapper
 * below is a public contract pinned by `tests/unit/hostStoreAuth.test.ts`: the
 * phone shell maps these codes to Chinese instead.
 */
export type SavedHostProblem = 'name' | 'hostname' | 'user' | 'port' | 'key';

/** Which field stops this record from being saved, or null when it is complete. */
export function savedHostProblem(host: SavedHost): SavedHostProblem | null {
  if (!host.name.trim()) return 'name';
  if (!host.hostname.trim()) return 'hostname';
  if (!host.user.trim()) return 'user';
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) return 'port';
  if (host.auth?.kind !== 'password' && !host.keyHandleId) return 'key';
  return null;
}

/** The shared app's copy for each problem: the sentences it has always shown. */
const SAVED_HOST_SENTENCE: Record<SavedHostProblem, string> = {
  name: 'Give the host a name.',
  hostname: 'Enter a hostname or IP address.',
  user: 'Enter the SSH user.',
  port: 'Port must be 1–65535.',
  key: 'Choose an SSH key from the key vault.',
};

/**
 * The shared contract's words. This wrapper is a public contract whose exact
 * sentences are pinned by `tests/unit/hostStoreAuth.test.ts`, so the phone shell
 * maps {@link savedHostProblem} codes to Chinese instead of changing them (R35,
 * R42). The shared app is not reachable in the packaged app; the pinned test is
 * the reason the strings stay byte-identical.
 */
export function validateSavedHost(host: SavedHost): string | null {
  const problem = savedHostProblem(host);
  return problem === null ? null : SAVED_HOST_SENTENCE[problem];
}

export class AndroidHostStore {
  private legacy: ImportedLegacyHost[] = [];

  constructor(private readonly options: AndroidHostStoreOptions) {}

  /** Saved hosts first, then 0.5.x imports whose names are not already taken. */
  async list(): Promise<HostEntry[]> {
    const saved = this.readSaved();
    this.legacy = await this.options.readLegacyHosts().catch(() => []);
    const names = new Set(saved.map((host) => host.name));
    const imported = this.legacy
      .filter((host) => !names.has(host.name))
      .map((host) => toEntry({ name: host.name, hostname: host.hostname, port: host.port, user: host.username }));
    return [...saved.map(toEntry), ...imported];
  }

  /** Add or replace a host, bound to a key-vault handle. */
  save(host: SavedHost): void {
    const problem = validateSavedHost(host);
    if (problem) throw new Error(problem);
    const record: SavedHost = {
      name: host.name.trim(),
      hostname: host.hostname.trim(),
      port: host.port,
      user: host.user.trim(),
      keyHandleId: host.keyHandleId,
      auth: host.auth,
      piSessionsDir: host.piSessionsDir,
      piCommand: host.piCommand,
    };
    // A host of the same name is replaced where it stands, never duplicated.
    const saved = this.readSaved();
    const at = saved.findIndex((existing) => existing.name === record.name);
    if (at >= 0) saved[at] = record;
    else saved.push(record);
    this.options.storage.setItem(ANDROID_HOSTS_STORAGE_KEY, JSON.stringify(saved));
  }

  /** Every saved host (metadata and key handle; never key bytes). */
  savedHosts(): SavedHost[] {
    return this.readSaved();
  }

  /** Saved hosts that authenticate with `handleId`. */
  hostsUsingKey(handleId: string): SavedHost[] {
    return this.readSaved().filter((host) => host.keyHandleId === handleId);
  }

  /**
   * Point the named hosts at `nextHandleId` ('' = no key) only if each still
   * uses `expectedHandleId`; all or nothing. The key-vault delete flow uses
   * it to detach and restore references (#2926 CredentialKeyManager).
   */
  replaceKeyHandle(names: readonly string[], expectedHandleId: string, nextHandleId: string): boolean {
    const saved = this.readSaved();
    const targets = saved.filter((host) => names.includes(host.name));
    if (targets.length !== names.length || targets.some((host) => host.keyHandleId !== expectedHandleId)) return false;
    for (const host of targets) host.keyHandleId = nextHandleId;
    this.options.storage.setItem(ANDROID_HOSTS_STORAGE_KEY, JSON.stringify(saved));
    return true;
  }

  remove(name: string): void {
    const saved = this.readSaved().filter((existing) => existing.name !== name);
    this.options.storage.setItem(ANDROID_HOSTS_STORAGE_KEY, JSON.stringify(saved));
  }

  /**
   * The dial target for a connect request, matched the way the shared store
   * names it: by alias first, then hostname + port.
   */
  async resolve(
    request: { host: string; port?: number; user: string; hostAlias?: string },
    credential?: SshCredential,
  ): Promise<SshHostTarget> {
    const port = request.port ?? 22;
    const saved = this.readSaved();
    const atAddress = (host: SavedHost) => host.hostname === request.host && host.port === port;
    // By alias, then the host at this address for this user, then any host at
    // this address: two hosts can share an address under different users.
    const savedMatch =
      (request.hostAlias ? saved.find((host) => host.name === request.hostAlias) : undefined) ??
      (request.user ? saved.find((host) => atAddress(host) && host.user === request.user) : undefined) ??
      saved.find(atAddress);
    if (savedMatch) {
      // The caller resolved the record's secret (Plan 4) and its credential is
      // authoritative: use it verbatim instead of refusing the dial.
      if (credential === undefined) {
        if (savedMatch.auth?.kind === 'password') {
          // The secret lives in the native vault; refuse rather than dial it
          // keyless with a misleading "choose a key" message.
          throw new Error(`“${savedMatch.name}” uses a password credential that is not available yet.`);
        }
        if (!savedMatch.keyHandleId) throw new MissingHostCredential(savedMatch);
      }
      return {
        hostId: `${savedMatch.user}@${savedMatch.hostname}:${savedMatch.port}`,
        hostname: savedMatch.hostname,
        port: savedMatch.port,
        username: request.user || savedMatch.user,
        credential: credential ?? { kind: 'key-handle', handleId: savedMatch.keyHandleId },
      };
    }
    if (this.legacy.length === 0) this.legacy = await this.options.readLegacyHosts().catch(() => []);
    const legacyMatch =
      (request.hostAlias ? this.legacy.find((host) => host.name === request.hostAlias) : undefined) ??
      this.legacy.find((host) => host.hostname === request.host && host.port === port);
    if (legacyMatch) {
      // The native plugin resolves the imported key's handle; no key bytes in JS.
      return makeLegacySshHostTarget(legacyMatch, '');
    }
    throw new Error(`No saved host for ${request.user ? `${request.user}@` : ''}${request.host}:${port}.`);
  }

  /**
   * The name the user knows a connect request's host by (the saved or
   * imported host's name, matched like {@link resolve}), for prompts such as
   * the host-key decision. Falls back to the hostname.
   */
  labelFor(request: { host: string; port?: number; hostAlias?: string }): string {
    if (request.hostAlias) return request.hostAlias;
    const port = request.port ?? 22;
    const match = (host: { hostname: string; port: number }) => host.hostname === request.host && host.port === port;
    return this.readSaved().find(match)?.name ?? this.legacy.find(match)?.name ?? request.host;
  }

  private readSaved(): SavedHost[] {
    const raw = this.options.storage.getItem(ANDROID_HOSTS_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isSavedHost) : [];
    } catch {
      return [];
    }
  }
}
