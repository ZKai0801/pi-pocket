import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createComposerDeliveryController } from '../../src/session/composerDelivery';

// The per-target draft store went away with the legacy shell's PromptComposer
// (chat-only cut, 2026-10-25); the caller now owns the draft. These cases keep
// the delivery adapter's coverage with a plain caller-owned draft variable.
describe('composer delivery adapter', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('retains an ambiguous draft and does not replay it after reconnect', async () => {
    let draft = 'café 🧪\nsecond line';
    const writePty = vi.fn(async () => ({ ok: false, message: 'PTY write acknowledgement was lost.' }));
    const delivery = createComposerDeliveryController(writePty, async () => undefined);
    delivery.setTransportState('connected');

    const result = await delivery.deliver({ operationId: 'ambiguous-send', payload: draft, intent: 'submit' });
    if (result.draftEffect === 'clear') draft = '';

    expect(result).toMatchObject({ status: 'uncertain', draftEffect: 'retain', stage: 'write' });
    expect(draft).toBe('café 🧪\nsecond line');

    delivery.setTransportState('lost');
    delivery.setTransportState('connected');
    expect(draft).toBe('café 🧪\nsecond line');
    expect(writePty).toHaveBeenCalledTimes(1);
  });

  it('treats an acknowledgement that arrives after transport loss as uncertain and stops the paste', async () => {
    let draft = 'first line\nsecond line';

    let resolveWrite: ((acknowledgement: { ok: boolean }) => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writePty = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      resolveWrite = resolve;
      markWriteStarted?.();
    }));
    const delivery = createComposerDeliveryController(writePty, async () => undefined);
    delivery.setTransportState('connected');

    const pending = delivery.deliver({ operationId: 'late-ack-submit', payload: draft, intent: 'submit' });
    await writeStarted;
    delivery.setTransportState('lost');
    resolveWrite?.({ ok: true });
    const result = await pending;
    if (result.draftEffect === 'clear') draft = '';

    expect(result).toMatchObject({ status: 'uncertain', reason: 'transport-lost', stage: 'write', draftEffect: 'retain', writeCount: 1 });
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(draft).toBe('first line\nsecond line');

    delivery.setTransportState('connected');
    expect(draft).toBe('first line\nsecond line');
    expect(writePty).toHaveBeenCalledTimes(1);
  });
});
