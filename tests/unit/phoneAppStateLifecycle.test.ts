import { describe, expect, it, vi } from 'vitest';
import { installAppStateLifecycle } from '../../src/phone/appStateLifecycle';

describe('phone background grace', () => {
  it('drives the app lifecycle handler from appStateChange and removes the listener', async () => {
    let listener: ((state: { isActive: boolean }) => void) | undefined;
    const remove = vi.fn();
    const app = {
      addListener: vi.fn(async (_event: 'appStateChange', callback: (state: { isActive: boolean }) => void) => {
        listener = callback;
        return { remove };
      }),
    };
    const controller = {
      getSnapshot: () => ({ phase: 'live' as const }),
      enterBackground: vi.fn(async () => {}),
      returnToForeground: vi.fn(async () => {}),
    };
    const onError = vi.fn();
    const dispose = installAppStateLifecycle({
      app,
      getController: () => controller,
      getBackgroundGraceMs: () => 12_000,
      getReconnectOnReturn: () => true,
      onError,
    });

    await vi.waitFor(() => expect(app.addListener).toHaveBeenCalledOnce());
    listener?.({ isActive: false });
    await vi.waitFor(() => expect(controller.enterBackground).toHaveBeenCalledWith(12_000));
    expect(onError).not.toHaveBeenCalled();

    dispose();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
  });

  it('reconnects on return with the shared reconnect flag', async () => {
    let listener: ((state: { isActive: boolean }) => void) | undefined;
    const app = {
      addListener: vi.fn(async (_event: 'appStateChange', callback: (state: { isActive: boolean }) => void) => {
        listener = callback;
        return { remove: vi.fn() };
      }),
    };
    let phase = 'live';
    const controller = {
      getSnapshot: () => ({ phase }),
      enterBackground: vi.fn(async (graceMs: number) => {
        expect(graceMs).toBe(12_000);
        phase = 'background';
      }),
      returnToForeground: vi.fn(async (options: { reconnect: boolean }) => {
        expect(options).toEqual({ reconnect: true });
        phase = 'live';
      }),
    };
    const onError = vi.fn();
    const dispose = installAppStateLifecycle({
      app,
      getController: () => controller,
      getBackgroundGraceMs: () => 12_000,
      getReconnectOnReturn: () => true,
      onError,
    });

    await vi.waitFor(() => expect(app.addListener).toHaveBeenCalledOnce());
    listener?.({ isActive: false });
    await vi.waitFor(() => expect(controller.enterBackground).toHaveBeenCalledOnce());
    listener?.({ isActive: true });
    await vi.waitFor(() => expect(controller.returnToForeground).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();

    dispose();
  });
});
