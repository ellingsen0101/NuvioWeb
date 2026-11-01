// Hand-off from the detail screen to the player route. Kept in memory on purpose: stream URLs can
// embed debrid or addon credentials, so they are not written to storage or to the URL.
let pending = null;

export function setPendingPlayback(state) {
  pending = state;
}

export function getPendingPlayback() {
  return pending;
}

export function clearPendingPlayback() {
  pending = null;
}
