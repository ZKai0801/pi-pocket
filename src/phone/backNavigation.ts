/**
 * The Android Back seam for the phone shell (spec §8.1). Shaped like the
 * existing `connectionPort` seam: the shell installs the owner
 * that consumes a Back press, and `@capacitor/app`'s `backButton` listener
 * drives it through {@link backNavigation}. Tabs are peer roots, so each keeps
 * its own stack; Back pops the active tab's stack and, at that tab's root,
 * hands off to the kept home-surface behaviour instead of exiting the app.
 */
import { reactive } from 'vue';
import {
  resolveAndroidBackDestination,
  type AndroidBackDestination,
  type HomeSurface,
} from '../session/homeSurface';

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

export interface BackButtonSource {
  addListener(
    event: 'backButton',
    listener: () => void,
  ): Promise<{ remove(): void }>;
}

export interface BackButtonOptions {
  app: BackButtonSource;
  onError?: (error: unknown) => void;
}

/**
 * Register the plugin's Back listener and hand each press to the installed
 * owner. The disposer removes a listener whose `addListener` promise is still
 * pending, and a press that arrives after disposal is ignored.
 */
export function installBackButton(options: BackButtonOptions): () => void {
  let disposed = false;
  let remove: (() => void) | undefined;
  void options.app
    .addListener('backButton', () => {
      if (!disposed) installed?.handleBack();
    })
    .then((listener) => {
      if (disposed) void listener.remove();
      else remove = () => { void listener.remove(); };
    })
    .catch(options.onError);
  return () => {
    disposed = true;
    remove?.();
  };
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

/**
 * A minimal per-tab stack of pushed views. Views stack rather than replace: the
 * 连接 tab pushes `editor` and then `keys` above it, so one Back pops the key
 * sheet and the next pops the editor. Each press pops exactly one view.
 */
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

/**
 * Drop every pushed view of one tab. Closing a parent view must not leave a
 * child stacked above a view that no longer exists — the 连接 tab pushes
 * `editor` and then `keys`, and closing the editor from its own 取消 closes
 * both.
 */
export function clearViews(stack: BackStack, tab: string): void {
  while (stack.current(tab) !== null) stack.pop(tab);
}

export interface ShellBackNavigationOptions {
  stack: BackStack;
  getActiveTab(): string;
  /** Close the topmost overlay/sheet; `true` when one was open. */
  closeOverlay(): boolean;
  /** Runs after the active tab's stack popped, e.g. to close the chat. */
  onPopped?(tab: string): void;
}

/**
 * The shell's Back order: topmost overlay/sheet first, then the active tab's
 * stack, then the tab root's home behaviour.
 */
export function createShellBackNavigation(
  options: ShellBackNavigationOptions,
): BackNavigationOwner {
  return {
    handleBack(): boolean {
      if (options.closeOverlay()) return true;
      const tab = options.getActiveTab();
      const handled = options.stack.handleBack();
      if (handled) options.onPopped?.(tab);
      return handled;
    },
  };
}

export interface HomeBackOptions {
  getSurface(): HomeSurface;
  /** Only a reconciled live connection counts; a failed dial must minimize. */
  hasLiveConnection(): boolean;
  minimize(): void | Promise<void>;
  onError?: (error: unknown) => void;
}

/** Apply the kept home-surface verdict: background at a tab root, never exit. */
export function runHomeBack(options: HomeBackOptions): void {
  const destination: AndroidBackDestination = resolveAndroidBackDestination(
    false,
    options.getSurface(),
    options.hasLiveConnection(),
  );
  if (destination !== 'minimize') return;
  try {
    void Promise.resolve(options.minimize()).catch(options.onError);
  } catch (error) {
    options.onError?.(error);
  }
}
