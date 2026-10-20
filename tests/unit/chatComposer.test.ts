// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatComposer from '../../src/components/sessions/ChatComposer.vue';

type SendResult = 'sent' | 'busy' | 'error';

interface Mounted {
  app: App;
  root: HTMLElement;
  state: { sending: boolean; error: string | null };
  input(): HTMLTextAreaElement;
  button(): HTMLButtonElement;
}

let mounted: Mounted | null = null;

function mountComposer(
  send: (text: string) => Promise<SendResult>,
  options: { sending?: boolean; error?: string | null } = {},
): Mounted {
  const state = reactive({
    sending: options.sending ?? false,
    error: options.error ?? null,
  });
  const Host = defineComponent({
    setup: () => () => h(ChatComposer, {
      send,
      sending: state.sending,
      error: state.error,
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
});
