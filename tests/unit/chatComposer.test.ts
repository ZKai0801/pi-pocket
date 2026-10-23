// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatComposer from '../../src/components/sessions/ChatComposer.vue';
import { PI_BUILTIN_COMMANDS } from '../../src/pi/piSlashCommands';
import { createChatCommandOptions, type ChatCommandOptions } from '../../src/session/chatCommandOptions';
import type { PiCommandOption } from '../../src/pi/piCommandOptions';

type SendResult = 'sent' | 'busy' | 'error';

interface Mounted {
  app: App;
  root: HTMLElement;
  state: { sending: boolean; error: string | null; notice: string | null; sheetOpen: boolean; running: boolean };
  requests: () => number;
  optionRequests: () => number;
  input(): HTMLTextAreaElement;
  button(): HTMLButtonElement;
  followUp(): HTMLButtonElement | null;
  sheet(): HTMLElement | null;
  rows(): HTMLButtonElement[];
  optionsSheet(): HTMLElement | null;
  optionRows(): HTMLButtonElement[];
}

let mounted: Mounted | null = null;

/** The picker's catalog, wired the way `ChatScreen` wires it: a probe per pick. */
function catalogWith(models: PiCommandOption[] = []): ChatCommandOptions {
  return createChatCommandOptions({
    projectPath: () => '/home/dev/git/pocketshell',
    listModels: async () => models,
  });
}

function mountComposer(
  send: (text: string, intent?: 'steer' | 'follow-up') => Promise<SendResult>,
  options: {
    sending?: boolean;
    error?: string | null;
    notice?: string | null;
    running?: boolean;
    commands?: typeof PI_BUILTIN_COMMANDS;
    commandsState?: 'idle' | 'loading' | 'ready' | 'error';
    commandOptions?: ChatCommandOptions | null;
  } = {},
): Mounted {
  const state = reactive({
    sending: options.sending ?? false,
    error: options.error ?? null,
    notice: options.notice ?? null,
    running: options.running ?? false,
    sheetOpen: false,
  });
  let requests = 0;
  let optionRequests = 0;
  const Host = defineComponent({
    setup: () => () => h(ChatComposer, {
      send,
      sending: state.sending,
      error: state.error,
      notice: state.notice,
      running: state.running,
      commands: options.commands ?? PI_BUILTIN_COMMANDS,
      commandsState: options.commandsState ?? 'ready',
      commandOptions: options.commandOptions ?? null,
      sheetOpen: state.sheetOpen,
      'onUpdate:sheetOpen': (open: boolean) => { state.sheetOpen = open; },
      onRequestCommands: () => { requests += 1; },
      onRequestOptions: (command: { command: string }) => {
        optionRequests += 1;
        void options.commandOptions?.load(command.command);
      },
    }),
  });
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(Host);
  app.mount(root);
  const harness: Mounted = {
    app,
    root,
    state,
    requests: () => requests,
    optionRequests: () => optionRequests,
    input: () => root.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement,
    button: () => root.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement,
    sheet: () => document.querySelector('[data-testid="chat-command-sheet"]') as HTMLElement | null,
    rows: () => Array.from(document.querySelectorAll('[data-testid="chat-command-option"]')) as HTMLButtonElement[],
    optionsSheet: () => document.querySelector('[data-testid="chat-command-options"]') as HTMLElement | null,
    optionRows: () => Array.from(document.querySelectorAll('[data-testid="chat-command-option-choice"]')) as HTMLButtonElement[],
    followUp: () => root.querySelector('[data-testid="chat-composer-follow-up"]'),
  };
  mounted = harness;
  return harness;
}

async function type(target: HTMLTextAreaElement, text: string): Promise<void> {
  target.value = text;
  target.dispatchEvent(new Event('input'));
  await nextTick();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

function rowFor(command: string): HTMLButtonElement {
  const row = document.querySelector(`[data-testid="chat-command-option"][data-command="${command}"]`);
  if (row === null) throw new Error(`no row for ${command}`);
  return row as HTMLButtonElement;
}

describe('chat composer', () => {
  afterEach(() => {
    mounted?.app.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('disables send while a turn is in flight but keeps the text editable', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const), { sending: true });
    await type(composer.input(), 'hello');

    expect(composer.button().disabled).toBe(true);
    expect(composer.input().disabled).toBe(false);
    expect(composer.root.querySelector('[data-testid="chat-composer-spinner"]')).not.toBeNull();
    expect(composer.button().getAttribute('aria-label')).toBe('发送');
  });

  it('clears the text only when the send reports sent', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const));
    await type(composer.input(), 'hello');

    composer.button().click();
    await settle();

    expect(composer.input().value).toBe('');
  });

  it('retains the text when the send reports an error', async () => {
    const composer = mountComposer(vi.fn(async () => 'error' as const));
    await type(composer.input(), 'hello');

    composer.button().click();
    await settle();

    expect(composer.input().value).toBe('hello');
  });

  it('retains the text when the send reports busy', async () => {
    const composer = mountComposer(vi.fn(async () => 'busy' as const));
    await type(composer.input(), 'hello');

    composer.button().click();
    await settle();

    expect(composer.input().value).toBe('hello');
  });

  it('renders the inline error as an alert', async () => {
    mountComposer(vi.fn(async () => 'sent' as const), { error: '等待回复超时，请重试。' });

    const alert = document.querySelector('[data-testid="chat-composer-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toBe('等待回复超时，请重试。');
  });

  it('turns the action into “+” only while the draft is empty', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const));
    expect(composer.button().dataset.mode).toBe('more');
    expect(composer.button().disabled).toBe(false);
    expect(composer.button().getAttribute('aria-label')).toBe('更多功能');

    await type(composer.input(), '   ');
    expect(composer.button().dataset.mode).toBe('send');
    expect(composer.button().disabled).toBe(true);

    await type(composer.input(), 'hello');
    expect(composer.button().dataset.mode).toBe('send');
    expect(composer.button().disabled).toBe(false);
  });

  it('opens the command sheet from “+” and asks the shell for commands', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const));

    composer.button().click();
    await nextTick();

    expect(composer.state.sheetOpen).toBe(true);
    expect(composer.requests()).toBe(1);
    expect(composer.sheet()).not.toBeNull();
    expect(rowFor('/model')).not.toBeNull();
  });

  it('inserts a picked command instead of sending it', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const composer = mountComposer(send);

    composer.button().click();
    await nextTick();
    rowFor('/model').click();
    await nextTick();

    // An argument-taking command keeps one trailing space for the caret.
    expect(composer.input().value).toBe('/model ');
    expect(composer.state.sheetOpen).toBe(false);
    expect(send).not.toHaveBeenCalled();
    // The draft is no longer empty, so the action is 发送 again.
    expect(composer.button().dataset.mode).toBe('send');
    expect(composer.button().getAttribute('aria-label')).toBe('发送');
  });

  it('inserts the colon form of /skill: without a separator', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const));

    composer.button().click();
    await nextTick();
    rowFor('/skill:').click();
    await nextTick();

    expect(composer.input().value).toBe('/skill:');
  });

  it('filters the sheet by command, description or source', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const));
    composer.button().click();
    await nextTick();
    const filter = document.querySelector('[data-testid="chat-command-filter"]') as HTMLInputElement;

    filter.value = 'compact';
    filter.dispatchEvent(new Event('input'));
    await nextTick();
    expect(composer.rows().map((row) => row.dataset.command)).toEqual(['/compact']);

    filter.value = '模型';
    filter.dispatchEvent(new Event('input'));
    await nextTick();
    expect(composer.rows().map((row) => row.dataset.command)).toContain('/model');

    filter.value = 'zzz';
    filter.dispatchEvent(new Event('input'));
    await nextTick();
    expect(composer.rows()).toHaveLength(0);
    expect(document.querySelector('[data-testid="chat-command-empty"]')).not.toBeNull();
  });

  it('keeps the built-ins and shows the host notice when discovery failed', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const), { commandsState: 'error' });

    composer.button().click();
    await nextTick();

    const notice = document.querySelector('[data-testid="chat-command-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('未能读取主机上的扩展命令');
    expect(rowFor('/compact')).not.toBeNull();
  });

  it('opens a second, smaller sheet for a command with a fixed choice set', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const), {
      commandOptions: catalogWith(),
    });

    composer.button().click();
    await nextTick();
    rowFor('/thinking').click();
    await settle();

    expect(composer.optionsSheet()).not.toBeNull();
    expect(composer.optionRows().map((row) => row.dataset.value)).toEqual([
      'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    // A choice that has not been made yet must not touch the draft or the
    // command sheet behind it.
    expect(composer.input().value).toBe('');
    expect(composer.state.sheetOpen).toBe(true);
  });

  it('inserts the completed text form when an option is picked', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const composer = mountComposer(send, { commandOptions: catalogWith() });

    composer.button().click();
    await nextTick();
    rowFor('/thinking').click();
    await settle();
    composer.optionRows().find((row) => row.dataset.value === 'high')?.click();
    await settle();

    // The text form is what keeps pi's own picker out of the hidden PTY.
    expect(composer.input().value).toBe('/thinking high');
    expect(composer.state.sheetOpen).toBe(false);
    expect(composer.optionsSheet()).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(composer.button().dataset.mode).toBe('send');
  });

  it('asks the shell for the model list when /model is picked', async () => {
    const commandOptions = catalogWith([
      { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4', detail: 'anthropic' },
      { value: 'openai/gpt-5-codex', label: 'openai/gpt-5-codex', detail: 'openai' },
    ]);
    const composer = mountComposer(vi.fn(async () => 'sent' as const), { commandOptions });

    composer.button().click();
    await nextTick();
    rowFor('/model').click();
    await settle();

    expect(composer.optionRequests()).toBe(1);
    expect(composer.optionsSheet()).not.toBeNull();
    expect(composer.optionRows().map((row) => row.dataset.value)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-5-codex',
    ]);
  });

  it('shows the host reason when the model probe fails, not just "could not read"', async () => {
    const commandOptions = createChatCommandOptions({
      projectPath: () => '/home/dev/git/pocketshell',
      listModels: async () => {
        throw new Error('error: cannot read ~/.pi/agent/models.json');
      },
    });
    const composer = mountComposer(vi.fn(async () => 'sent' as const), { commandOptions });

    composer.button().click();
    await nextTick();
    rowFor('/model').click();
    await settle();

    expect(composer.optionsSheet()).not.toBeNull();
    const reason = document.querySelector('[data-testid="chat-command-options-reason"]');
    expect(reason?.textContent?.trim()).toBe('error: cannot read ~/.pi/agent/models.json');
  });

  it('keeps the command sheet open when the option sheet is closed', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const), {
      commandOptions: catalogWith(),
    });

    composer.button().click();
    await nextTick();
    rowFor('/thinking').click();
    await settle();
    (document.querySelector('[data-testid="chat-command-options-close"]') as HTMLButtonElement).click();
    await settle();

    expect(composer.optionsSheet()).toBeNull();
    expect(composer.state.sheetOpen).toBe(true);
    expect(composer.sheet()).not.toBeNull();
  });

  it('closes both sheets when the outer one closes, so nothing is orphaned', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const), {
      commandOptions: catalogWith(),
    });

    composer.button().click();
    await nextTick();
    rowFor('/thinking').click();
    await settle();

    // Android Back closes the command sheet through the shell's own state.
    composer.state.sheetOpen = false;
    await nextTick();

    expect(composer.optionsSheet()).toBeNull();
  });

  it('still inserts a free-text command directly while a picker is available', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const), {
      commandOptions: catalogWith(),
    });

    composer.button().click();
    await nextTick();
    rowFor('/name').click();
    await settle();

    expect(composer.input().value).toBe('/name ');
    expect(composer.optionRequests()).toBe(0);
    expect(composer.optionsSheet()).toBeNull();
  });

  it('inserts /model directly when no picker catalog is installed', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const));

    composer.button().click();
    await nextTick();
    rowFor('/model').click();
    await settle();

    expect(composer.input().value).toBe('/model ');
    expect(composer.optionsSheet()).toBeNull();
  });
  it('shows a command notice as a status, not as an error', async () => {
    mountComposer(vi.fn(async () => 'sent' as const), {
      notice: '该命令的界面只能在终端里显示。下一条消息会重新连接到本会话。',
    });

    const notice = document.querySelector('[data-testid="chat-composer-notice"]');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('只能在终端里显示');
    expect(document.querySelector('[data-testid="chat-composer-error"]')).toBeNull();
  });

  it('opens the picker when the bare form of a picker command is sent', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const composer = mountComposer(send, {
      commandOptions: catalogWith([
        { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4' },
      ]),
    });

    await type(composer.input(), '/model');
    composer.button().click();
    await settle();

    // Delivering the bare form would open pi's own picker inside the turn PTY.
    expect(send).not.toHaveBeenCalled();
    expect(composer.optionRequests()).toBe(1);
    expect(composer.optionsSheet()).not.toBeNull();

    composer.optionRows()[0]?.click();
    await settle();

    expect(composer.input().value).toBe('/model anthropic/claude-sonnet-4');
    expect(composer.optionsSheet()).toBeNull();
  });

  it('sends the text form of a picker command as typed', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const composer = mountComposer(send, { commandOptions: catalogWith() });

    await type(composer.input(), '/model openai/gpt-5-codex');
    composer.button().click();
    await settle();

    expect(send).toHaveBeenCalledWith('/model openai/gpt-5-codex', undefined);
    expect(composer.optionRequests()).toBe(0);
  });

  it('sends a bare picker command as typed when no catalog is installed', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const composer = mountComposer(send);

    await type(composer.input(), '/model');
    composer.button().click();
    await settle();

    expect(send).toHaveBeenCalledWith('/model', undefined);
    expect(composer.optionsSheet()).toBeNull();
  });

  it('turns the send button into 插话 and offers 排队 while the chat is running', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const composer = mountComposer(send, { running: true });
    await type(composer.input(), 'stop, use ripgrep');

    expect(composer.button().textContent?.trim()).toBe('插话');
    expect(composer.button().getAttribute('data-intent')).toBe('steer');
    expect(composer.followUp()?.textContent?.trim()).toBe('排队');

    composer.button().click();
    await settle();

    // The primary button steers: it joins the run already under way.
    expect(send).toHaveBeenCalledWith('stop, use ripgrep', 'steer');
    expect(composer.input().value).toBe('');
  });

  it('queues a follow-up from the second button', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const composer = mountComposer(send, { running: true });
    await type(composer.input(), 'then run the tests');

    composer.followUp()?.click();
    await settle();

    expect(send).toHaveBeenCalledWith('then run the tests', 'follow-up');
    expect(composer.input().value).toBe('');
  });

  it('keeps one plain send button when nothing is running', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const composer = mountComposer(send);

    expect(composer.followUp()).toBeNull();

    await type(composer.input(), 'hello');
    expect(composer.button().textContent?.trim()).toBe('发送');
    composer.button().click();
    await settle();

    expect(send).toHaveBeenCalledWith('hello', undefined);
  });
});
