import { describe, expect, it, vi } from 'vitest';
import {
  createBackStack,
  installBackNavigation,
  backNavigation,
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

  it('calls the home behaviour at a tab root instead of consuming the press', () => {
    const onHomeBack = vi.fn();
    const stack = createBackStack({ getActiveTab: () => 'sessions', onHomeBack });
    expect(stack.handleBack()).toBe(false);
    expect(onHomeBack).toHaveBeenCalledOnce();
    stack.push('sessions', 'chat');
    expect(stack.handleBack()).toBe(true);
    expect(onHomeBack).toHaveBeenCalledOnce();
  });
});
