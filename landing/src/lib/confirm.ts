/**
 * Promise-based confirmation modal for the superadmin page (replaces window.confirm).
 * Render <ConfirmHost /> once on the page, then: if (await confirmDialog({...})) …
 */
import { writable } from "svelte/store";

export interface AskOptions {
  title: string;
  message?: string;
  /** Extra lines shown as a list (what will happen). */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** The user must type this exact text to enable the button (e.g. the e-mail of the account). */
  requireText?: string;
  /** Optional text field (reason, note…). */
  input?: { label: string; placeholder?: string; value?: string; multiline?: boolean };
  /** Optional checkbox (e.g. "cancel billing too"). */
  checkbox?: { label: string; checked?: boolean };
}
export interface AskResult {
  ok: boolean;
  value: string;
  checked: boolean;
}

export const askState = writable<(AskOptions & { resolve: (r: AskResult) => void }) | null>(null);

export function ask(opts: AskOptions): Promise<AskResult> {
  return new Promise((resolve) => askState.set({ ...opts, resolve }));
}

export async function confirmDialog(opts: AskOptions): Promise<boolean> {
  return (await ask(opts)).ok;
}
