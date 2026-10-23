// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatComposer from '../../src/components/sessions/ChatComposer.vue';

type SendResult = 'sent' | 'busy' | 'error';

interface Mounted {
  app: App;
  root: HTMLElement;
  state: { sending: boolean; error: string | null; running: boolean };
  input(): HTMLTextAreaElement;
  button(): HTMLButtonElement;
  followUp(): HTMLButtonElement | null;
}

let mounted: Mounted | null = null;

function mountComposer(
  send: (text: string, intent?: 'steer' | 'follow-up') => Promise<SendResult>,
  options: { sending?: boolean; error?: string | null; running?: boolean } = {},
): Mounted {
  const state = reactive({
    sending: options.sending ?? false,
    error: options.error ?? null,
    running: options.running ?? false,
  });
  const Host = defineComponent({
    setup: () => () => h(ChatComposer, {
      send,
      sending: state.sending,
      error: state.error,
      running: state.running,
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
    input: () => root.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement,
    button: () => root.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement,
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

  it('disables send for empty or whitespace text', async () => {
    const composer = mountComposer(vi.fn(async () => 'sent' as const));
    expect(composer.button().disabled).toBe(true);

    await type(composer.input(), '   ');
    expect(composer.button().disabled).toBe(true);

    await type(composer.input(), 'hello');
    expect(composer.button().disabled).toBe(false);
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
    expect(composer.button().textContent?.trim()).toBe('发送');

    await type(composer.input(), 'hello');
    composer.button().click();
    await settle();

    expect(send).toHaveBeenCalledWith('hello', undefined);
  });
});
