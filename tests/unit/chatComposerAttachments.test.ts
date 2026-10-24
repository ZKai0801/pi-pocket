// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import ChatComposer from '../../src/components/sessions/ChatComposer.vue';
import {
  installComposerAttach,
  type ComposerAttachLive,
  type ComposerAttachOutcome,
} from '../../src/session/composerAttach';

type SendResult = 'sent' | 'busy' | 'error';

interface Mounted {
  app: App;
  root: HTMLElement;
  state: { sending: boolean; attachmentScope: string };
  sent: { text: string; intent?: 'steer' | 'follow-up' }[];
  input(): HTMLTextAreaElement;
  attachButton(): HTMLButtonElement | null;
  chips(): string[];
  removeButtons(): HTMLButtonElement[];
  attachError(): string | null;
  sendButton(): HTMLButtonElement;
}

let mounted: Mounted | null = null;

function mountComposer(
  send: (text: string, intent?: 'steer' | 'follow-up') => Promise<SendResult>,
  options: { sending?: boolean; attachmentScope?: string } = {},
): Mounted {
  const state = reactive({
    sending: options.sending ?? false,
    attachmentScope: options.attachmentScope ?? 'dtc-site/main',
  });
  const sent: { text: string; intent?: 'steer' | 'follow-up' }[] = [];
  const Host = defineComponent({
    setup: () => () => h(ChatComposer, {
      send: async (text: string, intent?: 'steer' | 'follow-up') => {
        sent.push({ text, intent });
        return send(text, intent);
      },
      sending: state.sending,
      error: null,
      commands: [],
      commandsState: 'ready',
      commandOptions: null,
      sheetOpen: false,
      attachmentScope: state.attachmentScope,
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
    sent,
    input: () => root.querySelector('[data-testid="chat-composer-input"]') as HTMLTextAreaElement,
    attachButton: () => root.querySelector('[data-testid="chat-composer-attach"]'),
    chips: () => Array.from(root.querySelectorAll('.composer__chip-name')).map((node) => node.textContent ?? ''),
    removeButtons: () => Array.from(root.querySelectorAll('[data-testid="chat-composer-attachment-remove"]')),
    attachError: () => root.querySelector('[data-testid="chat-composer-attach-error"]')?.textContent?.trim() ?? null,
    sendButton: () => root.querySelector('[data-testid="chat-composer-send"]') as HTMLButtonElement,
  };
  mounted = harness;
  return harness;
}

/** Install a fake pick-and-stage surface for one test. */
function installAttach(outcome: ComposerAttachOutcome | (() => Promise<ComposerAttachOutcome>)): {
  calls: { scopeKey: string }[];
} {
  const calls: { scopeKey: string }[] = [];
  const live: ComposerAttachLive = {
    async attach(options) {
      calls.push({ scopeKey: options.scopeKey });
      return typeof outcome === 'function' ? await outcome() : outcome;
    },
  };
  installComposerAttach(live);
  return { calls };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await nextTick();
}

afterEach(() => {
  mounted?.app.unmount();
  mounted?.root.remove();
  mounted = null;
  installComposerAttach(null);
});

describe('chat composer attachments', () => {
  it('stages a pick and shows it as a chip without touching the draft', async () => {
    const attach = installAttach({ paths: ['~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-shot.png'], error: null });
    const ui = mountComposer(async () => 'sent');
    ui.input().value = 'look at this';
    ui.input().dispatchEvent(new Event('input'));
    await settle();

    ui.attachButton()?.click();
    await settle();

    // The scope the chat computed reaches the stager unchanged.
    expect(attach.calls).toEqual([{ scopeKey: 'dtc-site/main' }]);
    expect(ui.chips()).toEqual(['20260824-101500-01-shot.png']);
    // Attaching never rewrites the draft: the block is folded in at send time.
    expect(ui.input().value).toBe('look at this');
    expect(ui.attachError()).toBeNull();
  });

  it('folds the staged paths into the draft at send time and clears them after', async () => {
    installAttach({
      paths: [
        '~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-shot.png',
        '~/.pocketshell/attachments/dtc-site/main/20260824-101500-02-notes.txt',
      ],
      error: null,
    });
    const ui = mountComposer(async () => 'sent');
    ui.input().value = 'compare these';
    ui.input().dispatchEvent(new Event('input'));
    await settle();
    ui.attachButton()?.click();
    await settle();

    ui.sendButton().click();
    await settle();

    expect(ui.sent).toHaveLength(1);
    expect(ui.sent[0].text).toBe(
      'compare these\n\nAttached files:'
      + '\n- ~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-shot.png'
      + '\n- ~/.pocketshell/attachments/dtc-site/main/20260824-101500-02-notes.txt',
    );
    expect(ui.chips()).toEqual([]);
    expect(ui.input().value).toBe('');
  });

  it('allows an attachment-only send, where the block IS the message', async () => {
    installAttach({ paths: ['~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-shot.png'], error: null });
    const ui = mountComposer(async () => 'sent');
    ui.attachButton()?.click();
    await settle();

    // A staged file is something to send, so the button left “+” on its own.
    expect(ui.sendButton().dataset.mode).toBe('send');
    ui.sendButton().click();
    await settle();

    expect(ui.sent).toHaveLength(1);
    expect(ui.sent[0].text).toBe(
      'Attached files:\n- ~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-shot.png',
    );
  });

  it('keeps the files that landed on a partial failure, and says why', async () => {
    installAttach({
      paths: ['~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-ok.png'],
      error: 'Attachment upload failed: holiday.mp4: This file is larger than the upload limit.',
    });
    const ui = mountComposer(async () => 'sent');
    ui.attachButton()?.click();
    await settle();

    expect(ui.chips()).toEqual(['20260824-101500-01-ok.png']);
    expect(ui.attachError()).toContain('holiday.mp4');
  });

  it('treats a cancelled pick as nothing at all', async () => {
    installAttach({ paths: [], error: null });
    const ui = mountComposer(async () => 'sent');
    ui.attachButton()?.click();
    await settle();

    expect(ui.chips()).toEqual([]);
    expect(ui.attachError()).toBeNull();
    // Nothing was typed and nothing was staged: the button stays “+”.
    expect(ui.sendButton().dataset.mode).toBe('more');
  });

  it('reports a missing connection owner instead of throwing at the tap', async () => {
    // No installComposerAttach: the seam is empty, as it is before a connect.
    const ui = mountComposer(async () => 'sent');
    ui.attachButton()?.click();
    await settle();

    expect(ui.chips()).toEqual([]);
    expect(ui.attachError()).toContain('No live connection owner is installed yet.');
  });

  it('drops a removed chip from the message', async () => {
    installAttach({
      paths: [
        '~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-shot.png',
        '~/.pocketshell/attachments/dtc-site/main/20260824-101500-02-notes.txt',
      ],
      error: null,
    });
    const ui = mountComposer(async () => 'sent');
    ui.attachButton()?.click();
    await settle();

    ui.removeButtons()[0].click();
    await settle();
    expect(ui.chips()).toEqual(['20260824-101500-02-notes.txt']);

    ui.sendButton().click();
    await settle();
    expect(ui.sent[0].text).toBe(
      'Attached files:\n- ~/.pocketshell/attachments/dtc-site/main/20260824-101500-02-notes.txt',
    );
  });

  it('keeps text and files when the send did not land', async () => {
    installAttach({ paths: ['~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-shot.png'], error: null });
    const ui = mountComposer(async () => 'error');
    ui.input().value = 'try me';
    ui.input().dispatchEvent(new Event('input'));
    await settle();
    ui.attachButton()?.click();
    await settle();

    ui.sendButton().click();
    await settle();

    expect(ui.chips()).toEqual(['20260824-101500-01-shot.png']);
    expect(ui.input().value).toBe('try me');
  });

  it('hides the paperclip when there is no session to stage into', async () => {
    installAttach({ paths: [], error: null });
    const ui = mountComposer(async () => 'sent', { attachmentScope: '' });
    await settle();
    expect(ui.attachButton()).toBeNull();
  });

  it('shows the acknowledged byte count while the batch is in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    installComposerAttach({
      async attach(options) {
        options.onProgress?.({
          fileName: 'photo.png',
          fileIndex: 2,
          fileCount: 3,
          batchBytesWritten: 2 * 1024 * 1024,
          batchBytesTotal: 6 * 1024 * 1024,
        });
        await gate;
        return { paths: [], error: null };
      },
    });
    const ui = mountComposer(async () => 'sent');
    ui.attachButton()?.click();
    await settle();

    const progress = ui.root.querySelector('[data-testid="chat-composer-attach-progress"]');
    expect(progress?.textContent).toContain('2/3');
    // Both byte counts are shown, so a stalled bar is legible as "not moving"
    // rather than as an unknown wait.
    expect(progress?.textContent).toContain('MB');

    release();
    await settle();
    // The line is about the batch in flight; it does not outlive it.
    expect(ui.root.querySelector('[data-testid="chat-composer-attach-progress"]')).toBeNull();
  });
});
