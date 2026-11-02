#!/usr/bin/env node
/**
 * Headless smoke for the browser dev mode (#3022). Starts `pnpm dev:mock` or
 * `pnpm dev:live` itself, drives the app in Chromium at a phone viewport and
 * fails unless every journey step is observed.
 *
 *   node scripts/dev-browser-smoke.mjs mock
 *   node scripts/dev-browser-smoke.mjs live --host testuser@127.0.0.1:2222 --identity tests/docker/test_key
 *
 * Options:
 *   --port <n>          Vite port (default: a free one)
 *   --artifacts <dir>   where screenshots and result.json go (default build/dev-browser-smoke/<mode>)
 *   --chrome <path>     Chromium/Chrome executable (default: $CHROME_PATH, then common locations)
 *
 * mock journeys: the single phone shell at `/` — the seeded dev host is listed,
 * connecting asks for host-key trust, trusting it records the pin and the shell
 * reports a live connection, and the three tabs switch. The phone shell has no
 * composer, usage, session-list or terminal surface yet, so those steps are
 * recorded as explicit DEFER checks naming their owner instead of being
 * dropped (see the `smoke.defer()` calls).
 *
 * live journey: the same phone shell against the real host — the connect asks
 * for the key the host presents, checked against an independent SSH handshake,
 * and trusting it reaches a live connection. Creating a session and typing
 * into its real PTY needs the packaged terminal screen, so it is a DEFER
 * check for Plan 5 rather than a silent omission.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { chromium } from 'playwright-core';
import { parseArgs as parseLauncherArgs } from './dev-browser.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PHONE = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false };

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'mock' && mode !== 'live') throw new Error('usage: dev-browser-smoke.mjs mock|live [options]');
  const options = { mode, port: 0, artifacts: null, chrome: process.env.CHROME_PATH ?? null, launcher: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = () => {
      index += 1;
      if (rest[index] === undefined) throw new Error(`${arg} needs a value`);
      return rest[index];
    };
    if (arg === '--port') options.port = Number(value());
    else if (arg === '--artifacts') options.artifacts = path.resolve(value());
    else if (arg === '--chrome') options.chrome = value();
    else if (arg === '--host' || arg === '--identity') options.launcher.push(arg, value());
    else throw new Error(`unknown option ${arg}`);
  }
  options.artifacts ??= path.join(repoRoot, 'build', 'dev-browser-smoke', mode);
  const launcher = parseLauncherArgs([mode, ...options.launcher], {});
  if (mode === 'live' && (launcher.hosts.length !== 1 || launcher.identities.length !== 1)) {
    throw new Error('live smoke needs exactly one --host and one --identity');
  }
  options.host = launcher.hosts[0] ?? null;
  options.identity = launcher.identities[0] ?? null;
  return options;
}

function findChrome(explicit) {
  const candidates = [explicit, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((name) => /^chromium-\d+$/u.test(name)).sort().reverse()) {
      candidates.push(path.join(cache, dir, 'chrome-linux64', 'chrome'), path.join(cache, dir, 'chrome-linux', 'chrome'));
    }
  }
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error('No Chrome/Chromium found; set CHROME_PATH or pass --chrome');
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Vite colours its banner whenever it thinks colour is supported, which
 * includes `CI=true` with no TTY. Readiness and token matching run on the
 * de-coloured text so an escape between `Local` and `:` cannot hide it.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
const stripAnsi = (text) => text.replace(ANSI_ESCAPE, '');

/**
 * The first VISIBLE element with this text. Plain `getByText(...).first()` can
 * land on an invisible match: the shared session tree draws an agent-mark SVG
 * whose `<title>` repeats the session name ahead of the clickable label.
 */
const visibleText = (page, text, options) => page.getByText(text, options).locator('visible=true').first();

/** Start the dev launcher and resolve once Vite is serving. */
function startDevServer(options, port) {
  const args = [path.join(repoRoot, 'scripts', 'dev-browser.mjs'), options.mode, ...options.launcher, '--port', String(port), '--', '--strictPort'];
  const child = spawn(process.execPath, args, { cwd: repoRoot, env: { ...process.env, BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
  let rawLog = '';
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev server did not start:\n${log}`)), 60_000);
    const onData = (chunk) => {
      // Strip the whole log, not each chunk: an escape can straddle chunks.
      rawLog += chunk.toString();
      log = stripAnsi(rawLog);
      if (/Local:\s+http:\/\//u.test(log)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited (${code}):\n${log}`));
    });
  });
  // dev:live prints the page URL with the per-run bridge token in its fragment.
  const token = () => /#devBridgeToken=([A-Za-z0-9_-]+)/u.exec(log)?.[1] ?? '';
  const redactedLog = () => {
    const secret = token();
    return secret ? log.split(secret).join('<bridge-token>') : log;
  };
  return { child, ready, token, log: redactedLog };
}

class Smoke {
  constructor(artifacts) {
    this.artifacts = artifacts;
    this.checks = [];
    this.console = [];
    this.retries = [];
  }

  /** Keep the page's console, errors and reloads for browser-console.log. */
  watch(page, label) {
    const started = Date.now();
    const note = (line) => this.console.push(`+${String(Date.now() - started).padStart(6)}ms [${label}] ${line}`);
    page.on('console', (message) => note(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => note(`pageerror: ${error.message}`));
    page.on('load', () => note('load'));
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? '';
      if (reason.includes('ERR_NETWORK_CHANGED')) page.networkChanged = true;
      note(`requestfailed: ${request.url().split('#')[0]} ${reason}`);
    });
    return page;
  }

  /**
   * Open the app and wait until Vue replaced the boot fallback. Chromium
   * aborts every in-flight request with ERR_NETWORK_CHANGED when the host's
   * interfaces change (Docker containers starting or stopping elsewhere on a
   * shared box), which kills the dev server's module graph mid-load. Only
   * that signature earns one more load, and it is recorded in the check.
   */
  async open(page, url) {
    for (let attempt = 1; ; attempt += 1) {
      page.networkChanged = false;
      // A second goto to the same URL plus a fragment would only be an
      // in-page hash change; reload instead (live mode keeps the token in
      // the tab's sessionStorage).
      if (attempt === 1) await page.goto(url);
      else await page.reload();
      const mounted = await page.waitForFunction(() => !document.querySelector('#app .boot-fallback'), null, { timeout: 30_000 })
        .then(() => true, () => false);
      if (mounted) {
        if (attempt > 1) this.retries.push(`${url.split('#')[0]}: reloaded once after ERR_NETWORK_CHANGED`);
        return;
      }
      if (attempt > 1 || !page.networkChanged) throw new Error(`the app did not mount at ${url.split('#')[0]}`);
    }
  }

  async step(name, run) {
    const started = Date.now();
    try {
      const detail = await run();
      this.checks.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
      process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ''}\n`);
    } catch (error) {
      this.checks.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
      process.stdout.write(`FAIL ${name}: ${error?.message ?? error}\n`);
      throw error;
    }
  }

  /**
   * A step this round cannot drive yet, recorded rather than dropped: it stays
   * in result.json as `deferred` with the owner and the one-line reason, so the
   * gap is visible in CI evidence instead of vanishing from the script.
   */
  defer(name, reason) {
    this.checks.push({ name, ok: true, deferred: true, reason });
    process.stdout.write(`DEFER ${name} — ${reason}\n`);
  }
}

async function shot(page, smoke, name) {
  const file = path.join(smoke.artifacts, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** The mock host's fixed ed25519 key, rebuilt here as an independent oracle. */
function mockHostFingerprint() {
  const type = Buffer.from('ssh-ed25519');
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 37 + 11) & 0xff));
  const length = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value.length); return buffer; };
  const blob = Buffer.concat([length(type), type, length(key), key]);
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`;
}

/** The real host's key fingerprint, read over an independent SSH handshake. */
function liveHostFingerprint(options) {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let fingerprint = null;
    client.once('ready', () => { client.end(); resolve(fingerprint); });
    client.once('error', (error) => (fingerprint ? resolve(fingerprint) : reject(error)));
    client.connect({
      host: options.host.hostname,
      port: options.host.port,
      username: options.host.user,
      privateKey: readFileSync(options.identity),
      readyTimeout: 15_000,
      hostVerifier: (key) => {
        fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
        return true;
      },
    });
  });
}

/**
 * Connect the seeded dev host through the phone shell: the saved host row, the
 * host-key prompt and the live phase. The phone shell owns the controller, so
 * there is no separate connect form any more.
 */
async function connectPhone(page, smoke, hostLabel, expectedFingerprint) {
  await smoke.step('phone: the connections tab lists the saved dev host', async () => {
    await page.waitForSelector('[data-testid="phone-tab-connections"]', { timeout: 30_000 });
    await visibleText(page, hostLabel).waitFor({ timeout: 20_000 });
    await shot(page, smoke, 'phone-01-connections');
    return hostLabel;
  });
  await smoke.step('phone: tapping the host asks for host-key trust with the presented fingerprint', async () => {
    await visibleText(page, hostLabel).click();
    await page.waitForSelector('[data-testid="host-key-decision"]', { timeout: 20_000 });
    const text = await page.locator('body').innerText();
    if (!text.includes(expectedFingerprint)) throw new Error(`the trust prompt does not show the host's fingerprint ${expectedFingerprint}`);
    await shot(page, smoke, 'phone-02-trust');
    await page.click('[data-testid="trust-host-key"]');
    return expectedFingerprint;
  });
  await smoke.step('phone: trusting the key records the pin and reaches a live connection', async () => {
    await page.waitForFunction(
      () => ['connected', 'listing', 'live'].includes(document.querySelector('[data-testid="phone-shell"]')?.getAttribute('data-ssh-phase') ?? ''),
      null,
      { timeout: 30_000 },
    );
    const pins = await page.evaluate(() => Object.keys(localStorage)
      .filter((key) => key.startsWith('pocketshell.ssh.host-key.'))
      .map((key) => ({ key, value: localStorage.getItem(key) })));
    if (pins.length === 0) throw new Error('no host-key pin was recorded after trusting the key');
    // The pin must be the key the host actually presented, read independently
    // over SSH for the live host and rebuilt from the mock's fixed key.
    if (!pins.some((pin) => pin.value?.includes(expectedFingerprint))) {
      throw new Error(`the recorded pin does not carry the presented fingerprint ${expectedFingerprint}`);
    }
    const phase = await page.getAttribute('[data-testid="phone-shell"]', 'data-ssh-phase');
    await shot(page, smoke, 'phone-03-connected');
    return `phase ${phase}; pin ${pins[0].key}`;
  });
}

async function mockJourneys(browser, base, smoke) {
  const context = await browser.newContext(PHONE);
  const page = smoke.watch(await context.newPage(), 'phone');
  await smoke.open(page, `${base}/`);
  await smoke.step('phone: the single shell mounts with its three tabs', async () => {
    await page.waitForSelector('[data-testid="phone-shell"]', { timeout: 30_000 });
    for (const tab of ['connections', 'projects', 'sessions']) {
      await page.waitForSelector(`[data-testid="phone-tab-${tab}"]`, { timeout: 10_000 });
    }
    return '连接 / 项目 / 会话';
  });
  await connectPhone(page, smoke, 'mock-devbox', mockHostFingerprint());
  await smoke.step('phone: the tab bar switches between the three roots', async () => {
    const heading = (tab) => page.locator(`[data-testid="phone-shell"][data-route="${tab}"]`);
    await page.click('[data-testid="phone-tab-projects"]');
    await heading('projects').waitFor({ timeout: 10_000 });
    await page.getByRole('heading', { name: '项目' }).waitFor({ timeout: 10_000 });
    await shot(page, smoke, 'phone-04-projects');
    await page.click('[data-testid="phone-tab-sessions"]');
    await heading('sessions').waitFor({ timeout: 10_000 });
    await page.getByRole('heading', { name: '会话' }).waitFor({ timeout: 10_000 });
    await page.click('[data-testid="phone-tab-connections"]');
    await heading('connections').waitFor({ timeout: 10_000 });
    return 'projects → sessions → connections';
  });
  // The mock host does not answer the phone shell's remote-context probe
  // (`printf '%s\n%s\n' "$HOME" "${PI_CODING_AGENT_SESSION_DIR-}"`) or the
  // `test -d` root probe, so the projects list cannot be discovered here yet.
  smoke.defer(
    'phone: projects discovery lists the mock host workspaces',
    'DEFERRED — the mock host does not answer the phone shell remote-context/test -d probes; owner: Plan 2 follow-up',
  );
  smoke.defer(
    'phone: a session opens the terminal and echoes typed input',
    'DEFERRED — the phone shell has no session selection until projects discovery works, and the terminal is Plan 5 packaged acceptance',
  );
  smoke.defer(
    'phone: the composer sends a command to the terminal',
    'DEFERRED — the phone shell has no composer; owner: Plan 3',
  );
  smoke.defer(
    'phone: provider usage and settings are reachable',
    'DEFERRED — the phone shell has no settings or usage surface; owner: Plan 5 packaged acceptance',
  );

  await smoke.step('vite: a hot update applies without reloading the page', async () => {
    const probeDir = path.join(repoRoot, 'build', 'dev-browser-smoke', 'hmr');
    mkdirSync(probeDir, { recursive: true });
    const probe = path.join(probeDir, `probe-${randomBytes(3).toString('hex')}.css`);
    writeFileSync(probe, ':root { --ps-hmr-probe: one; }\n');
    try {
      const url = `/${path.relative(repoRoot, probe).split(path.sep).join('/')}`;
      await page.evaluate(async (specifier) => {
        window.__psHmrPageMarker = 'still-the-same-page';
        await import(/* @vite-ignore */ specifier);
      }, url);
      const read = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ps-hmr-probe').trim());
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ps-hmr-probe').trim() === 'one', null, { timeout: 10_000 });
      writeFileSync(probe, ':root { --ps-hmr-probe: two; }\n');
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ps-hmr-probe').trim() === 'two', null, { timeout: 15_000 });
      const sameDocument = await page.evaluate(() => window.__psHmrPageMarker === 'still-the-same-page');
      if (!sameDocument) throw new Error('the page reloaded instead of hot-updating');
      return `--ps-hmr-probe ${'one'} → ${await read()} in place`;
    } finally {
      rmSync(probe, { force: true });
    }
  });
  await context.close();
}

async function liveJourney(browser, base, smoke, options, token) {
  if (!token) throw new Error('dev:live did not print the page URL with its bridge token');
  // The token rides in the fragment, exactly as a developer opens the printed URL.
  const entry = (pathAndQuery) => `${base}${pathAndQuery}#devBridgeToken=${token}`;
  const context = await browser.newContext(PHONE);
  const page = smoke.watch(await context.newPage(), 'phone');
  try {
    await smoke.open(page, entry('/'));
    await smoke.step('live: the page takes the bridge token from the fragment and clears it from the URL', async () => {
      await page.waitForFunction(() => document.documentElement.dataset.devBrowser === 'live', null, { timeout: 30_000 });
      if (page.url().includes(token)) throw new Error('the bridge token is still in the address bar');
      const html = await (await fetch(`${base}/`)).text();
      if (html.includes(token)) throw new Error('the served page carries the bridge token');
      return page.url();
    });
    await smoke.step('live: the phone shell mounts with its three tabs', async () => {
      await page.waitForSelector('[data-testid="phone-shell"]', { timeout: 30_000 });
      for (const tab of ['connections', 'projects', 'sessions']) {
        await page.waitForSelector(`[data-testid="phone-tab-${tab}"]`, { timeout: 10_000 });
      }
      return '连接 / 项目 / 会话';
    });
    await connectPhone(page, smoke, options.host.name, await liveHostFingerprint(options));
    // The phone shell's terminal is the secondary screen Plan 5 accepts on a
    // device; the browser smoke can reach the live connection but has no
    // session list to open a PTY from.
    smoke.defer(
      'live: create a fresh session on the real host',
      'DEFERRED — the phone shell creates sessions from the packaged terminal screen; owner: Plan 5 packaged acceptance',
    );
    smoke.defer(
      'live: type into the real PTY and an independent SSH connection reads what it wrote',
      'DEFERRED — needs the terminal screen and a session to attach to; owner: Plan 5 packaged acceptance',
    );
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.artifacts, { recursive: true });
  const smoke = new Smoke(options.artifacts);
  const port = options.port || await freePort();
  const server = startDevServer(options, port);
  let browser = null;
  let failed = false;
  try {
    await server.ready;
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ executablePath: findChrome(options.chrome), headless: true, args: ['--no-sandbox'] });
    if (options.mode === 'mock') await mockJourneys(browser, base, smoke);
    else await liveJourney(browser, base, smoke, options, server.token());
  } catch (error) {
    failed = true;
    if (!smoke.checks.some((check) => !check.ok)) {
      smoke.checks.push({ name: 'harness', ok: false, error: String(error?.message ?? error) });
      process.stdout.write(`FAIL harness: ${error?.message ?? error}\n`);
    }
  } finally {
    await browser?.close().catch(() => undefined);
    server.child.kill('SIGTERM');
    writeFileSync(path.join(options.artifacts, 'dev-server.log'), server.log());
    const secret = server.token();
    const consoleLog = smoke.console.join('\n');
    writeFileSync(path.join(options.artifacts, 'browser-console.log'), `${secret ? consoleLog.split(secret).join('<bridge-token>') : consoleLog}\n`);
  }
  const passed = smoke.checks.filter((check) => check.ok).length;
  const result = { mode: options.mode, passed, failed: smoke.checks.length - passed, checks: smoke.checks, infraRetries: smoke.retries };
  writeFileSync(path.join(options.artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${options.mode} smoke: ${passed}/${smoke.checks.length} checks passed; artifacts in ${options.artifacts}\n`);
  if (failed || passed === 0 || result.failed > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`dev-browser-smoke: ${error?.message ?? error}\n`);
  process.exit(2);
});
