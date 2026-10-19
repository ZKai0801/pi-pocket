/**
 * The Android Back seam for the phone shell (spec §8.1). Shaped like the
 * existing `terminalPty`/`connectionPort` seams: the shell installs the owner
 * that consumes a Back press, and `@capacitor/app`'s `backButton` listener
 * drives it through {@link backNavigation}. Tabs are peer roots, so each keeps
 * its own stack; Back pops the active tab's stack and, at that tab's root,
 * hands off to the kept home-surface behaviour instead of exiting the app.
 */
import { reactive } from 'vue';

export interface BackNavigationOwner {
  /** Consume one Back press; `true` when a tab stack popped, `false` at root. */
  handleBack(): boolean;
}

let installed: BackNavigationOwner | null = null;

/** Hand the shell's per-tab back stack to the Back listener; null to release it. */
export function installBackNavigation(owner: BackNavigationOwner | null): void {
  installed = owner;
}

/** The installed owner; throws when no shell has claimed Back yet. */
export function backNavigation(): BackNavigationOwner {
  if (!installed) throw new Error('No back-navigation owner is installed yet.');
  return installed;
}

export interface BackStackOptions {
  getActiveTab(): string;
  /** Root Back (spec §8.1): the shell decides; never exit the app. */
  onHomeBack?: () => void;
}

export interface BackStack {
  current(tab: string): string | null;
  push(tab: string, view: string): void;
  pop(tab: string): string | null;
  /** Pop the active tab's stack; `false` when it was already at its root. */
  handleBack(): boolean;
}

/** A minimal per-tab stack: v1 tabs carry at most one pushed view each. */
export function createBackStack(options: BackStackOptions): BackStack {
  const stacks = reactive<Record<string, string[]>>({});

  function ensure(tab: string): string[] {
    const existing = stacks[tab];
    if (existing) return existing;
    const created: string[] = [];
    stacks[tab] = created;
    return created;
  }

  return {
    current(tab: string): string | null {
      const views = stacks[tab];
      return views && views.length > 0 ? views[views.length - 1] : null;
    },
    push(tab: string, view: string): void {
      ensure(tab).push(view);
    },
    pop(tab: string): string | null {
      return ensure(tab).pop() ?? null;
    },
    handleBack(): boolean {
      const views = stacks[options.getActiveTab()];
      if (views && views.length > 0) {
        views.pop();
        return true;
      }
      options.onHomeBack?.();
      return false;
    },
  };
}
