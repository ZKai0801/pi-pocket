export interface ConnectionSnapshotLike {
  phase: string;
}

export interface ConnectionSnapshotSyncOptions<T extends ConnectionSnapshotLike> {
  /** Keep the shell's local copy (the terminal/trust UI reads it). */
  onSnapshot(snapshot: T): void;
  /** Reconcile the per-host connection status with the controller. */
  apply(phase: string): void;
}

/** One subscription callback: local copy plus the store's reconciled status. */
export function createConnectionSnapshotSync<T extends ConnectionSnapshotLike>(
  options: ConnectionSnapshotSyncOptions<T>,
): (snapshot: T) => void {
  return (snapshot) => {
    options.onSnapshot(snapshot);
    options.apply(snapshot.phase);
  };
}
