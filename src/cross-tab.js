// Cross-tab workspace revisions (lab, 2026-11-02).
//
// Every save writes the whole in-memory workspace to the single `state.v1`
// record, and boot reads it once. Without a revision, a tab that booted
// earlier silently overwrites a newer tab's whole workspace, even when the
// two tabs edited different things. IndexedDB's per-record put is atomic,
// so this is silent overwrite, not corruption.
//
// The revision is a monotonically increasing integer carried on the state
// object itself. A tab remembers the revision it last saw (at boot, or
// after its own successful save). A checked write reads the stored record
// first: if the stored revision differs from the last seen revision,
// another tab saved in between and this write must not overwrite it.
//
// Limits, stated plainly because they shape the test:
// - This catches the sequential case (tab A saves, stale tab B saves
//   later). It is not an atomic compare-and-swap: two tabs that start a
//   checked write at the same instant can still race, because IndexedDB
//   offers no CAS and BroadcastChannel delivery is asynchronous. The
//   channel warning below narrows that window; it does not close it.
// - Legacy states carry no revision and are treated as revision 0, so
//   their first checked save stamps revision 1 instead of conflicting.
// - The boot recovery guard stays ahead of this logic: a tab in recovery
//   mode never reaches a checked write, so a revision check can never
//   unblock overwriting a preserved unreadable workspace.
export const CROSS_TAB_CHANNEL = 'mm-studio-cross-tab';
export function revisionOf(state) {
  return state && Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
}
export function isCrossTabConflict(stored, lastSeenRevision) {
  if (stored === null || stored === undefined) return false;
  if (lastSeenRevision === null || lastSeenRevision === undefined) return false;
  return revisionOf(stored) !== lastSeenRevision;
}
export function nextRevision(lastSeenRevision, stored) {
  return Math.max(lastSeenRevision ?? 0, revisionOf(stored)) + 1;
}
export function crossTabConflictMessage(stored, lastSeenRevision) {
  return `Cross-tab conflict: stored workspace revision ${revisionOf(stored)} differs from this tab's last seen revision ${lastSeenRevision}.`;
}
