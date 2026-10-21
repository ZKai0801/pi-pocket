import { describe, expect, it, vi } from 'vitest';
import {
  clearViews,
  createBackStack,
  createShellBackNavigation,
  installBackButton,
  installBackNavigation,
  backNavigation,
  runHomeBack,
} from '../../src/phone/backNavigation';

describe('phone back navigation', () => {
  it('throws until a back-navigation owner is installed, then hands it back', () => {
    installBackNavigation(null);
    expect(() => backNavigation()).toThrow();
    const owner = { handleBack: () => true };
    installBackNavigation(owner);
    expect(backNavigation()).toBe(owner);
    installBackNavigation(null);
    expect(() => backNavigation()).toThrow();
  });

  it('pops the active tab stack and leaves the other tab pushed', () => {
    let active = 'connections';
    const stack = createBackStack({ getActiveTab: () => active });
    stack.push('connections', 'editor');
    stack.push('sessions', 'chat');
    expect(stack.current('connections')).toBe('editor');
    expect(stack.handleBack()).toBe(true);
    expect(stack.current('connections')).toBeNull();
    expect(stack.current('sessions')).toBe('chat');
  });

  it('keeps each tab stack through a tab switch', () => {
    let active = 'connections';
    const stack = createBackStack({ getActiveTab: () => active });
    stack.push('connections', 'editor');
    active = 'sessions';
    stack.push('sessions', 'chat');
    active = 'connections';
    expect(stack.current('connections')).toBe('editor');
    expect(stack.current('sessions')).toBe('chat');
    expect(stack.handleBack()).toBe(true);
    expect(stack.current('connections')).toBeNull();
    expect(stack.current('sessions')).toBe('chat');
  });

  it('clears every stacked view of a tab, so a closed parent leaves no stale child', () => {
    const onHomeBack = vi.fn();
    const stack = createBackStack({ getActiveTab: () => 'connections', onHomeBack });
    stack.push('connections', 'editor');
    stack.push('connections', 'keys');
    expect(stack.current('connections')).toBe('keys');

    clearViews(stack, 'connections');

    // One `pop` would leave 'editor' here; the editor is gone, so nothing may
    // stay above it.
    expect(stack.current('connections')).toBeNull();
    // Back now reaches the tab root instead of a view that no longer exists.
    expect(stack.handleBack()).toBe(false);
    expect(onHomeBack).toHaveBeenCalledOnce();
  });

  it('clears a single-view stack exactly like one pop', () => {
    const stack = createBackStack({ getActiveTab: () => 'connections' });
    stack.push('connections', 'editor');
    stack.push('sessions', 'chat');

    clearViews(stack, 'connections');

    expect(stack.current('connections')).toBeNull();
    expect(stack.current('sessions')).toBe('chat');
  });

  it('calls the home behaviour at a tab root instead of consuming the press', () => {
    const onHomeBack = vi.fn();
    const stack = createBackStack({ getActiveTab: () => 'sessions', onHomeBack });
    expect(stack.handleBack()).toBe(false);
    expect(onHomeBack).toHaveBeenCalledOnce();
    stack.push('sessions', 'chat');
    expect(stack.handleBack()).toBe(true);
    expect(onHomeBack).toHaveBeenCalledOnce();
  });

  it('drives the active tab stack from an installed plugin listener', async () => {
    let active = 'connections';
    let press: (() => void) | undefined;
    const app = {
      addListener: vi.fn(async (_event: 'backButton', listener: () => void) => {
        press = listener;
        return { remove: vi.fn() };
      }),
    };
    const stack = createBackStack({ getActiveTab: () => active });
    stack.push('connections', 'editor');
    stack.push('sessions', 'chat');
    const owner = createShellBackNavigation({
      stack,
      getActiveTab: () => active,
      closeOverlay: () => false,
    });
    installBackNavigation(owner);
    const dispose = installBackButton({ app });

    await vi.waitFor(() => expect(press).toBeDefined());
    press?.();
    expect(stack.current('connections')).toBeNull();
    expect(stack.current('sessions')).toBe('chat');

    active = 'sessions';
    press?.();
    expect(stack.current('sessions')).toBeNull();

    dispose();
    installBackNavigation(null);
  });

  it('closes the topmost overlay before popping the tab stack', () => {
    const closeOverlay = vi.fn(() => true);
    const stack = createBackStack({ getActiveTab: () => 'projects' });
    stack.push('projects', 'browser');
    const owner = createShellBackNavigation({
      stack,
      getActiveTab: () => 'projects',
      closeOverlay,
    });

    expect(owner.handleBack()).toBe(true);
    expect(closeOverlay).toHaveBeenCalledOnce();
    expect(stack.current('projects')).toBe('browser');

    closeOverlay.mockReturnValue(false);
    expect(owner.handleBack()).toBe(true);
    expect(stack.current('projects')).toBeNull();
  });

  it('removes a listener that resolves after disposal and ignores a late press', async () => {
    let resolveAdd: ((handle: { remove(): void }) => void) | undefined;
    let press: (() => void) | undefined;
    const remove = vi.fn();
    const app = {
      addListener: vi.fn((_event: 'backButton', listener: () => void) => {
        press = listener;
        return new Promise<{ remove(): void }>((resolve) => { resolveAdd = resolve; });
      }),
    };
    const owner = { handleBack: vi.fn(() => true) };
    installBackNavigation(owner);

    const dispose = installBackButton({ app });
    dispose();
    resolveAdd?.({ remove });

    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    press?.();
    expect(owner.handleBack).not.toHaveBeenCalled();
    installBackNavigation(null);
  });

  it('minimizes at a tab root when the dial has no live connection', () => {
    const minimize = vi.fn();
    runHomeBack({
      getSurface: () => 'sessions',
      hasLiveConnection: () => false,
      minimize,
    });
    expect(minimize).toHaveBeenCalledOnce();
  });
});
