// The secret of a key made on the Connect page, kept in this tab's memory only. It is shown once by the backend, so it
// is never stored anywhere that survives a reload (no storage, no cookie, no URL). Keeping it for the life of the page
// lets the finished command stay on screen while the user switches between steps and tabs.

export interface VaultKey { id: string; secret: string }

let current: VaultKey | null = null;
const listeners = new Set<() => void>();

export const keyVault = {
  get: () => current,
  set(next: VaultKey | null) {
    current = next;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};
