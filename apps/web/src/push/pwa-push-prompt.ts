import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

export const PWA_PUSH_PROMPT_HANDLED_STORAGE_KEY = "salchi:pwa-push-prompt-handled:v1";
export const PUSH_PROMPT_DISMISSED_AT_STORAGE_KEY = "salchi:push-prompt-dismissed-at:v2";
export const PUSH_PROMPT_DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1_000;

const PwaPushPromptHandledSchema = Schema.Boolean;
const PushPromptDismissedAtSchema = Schema.Number;

export type PushPromptSurface = "standalone-pwa" | "desktop-web" | "other";

export function isPushPromptDismissalActive(dismissedAt: number | null, now = Date.now()): boolean {
  return (
    dismissedAt !== null &&
    Number.isFinite(dismissedAt) &&
    dismissedAt <= now &&
    now - dismissedAt < PUSH_PROMPT_DISMISS_COOLDOWN_MS
  );
}

export function isPwaPushPromptHandled(): boolean {
  try {
    const legacyPromptHandled =
      getLocalStorageItem(PWA_PUSH_PROMPT_HANDLED_STORAGE_KEY, PwaPushPromptHandledSchema) === true;
    if (legacyPromptHandled) {
      return true;
    }

    const dismissedAt = getLocalStorageItem(
      PUSH_PROMPT_DISMISSED_AT_STORAGE_KEY,
      PushPromptDismissedAtSchema,
    );
    return isPushPromptDismissalActive(dismissedAt);
  } catch {
    return false;
  }
}

export function markPwaPushPromptHandled(): void {
  try {
    setLocalStorageItem(
      PUSH_PROMPT_DISMISSED_AT_STORAGE_KEY,
      Date.now(),
      PushPromptDismissedAtSchema,
    );
  } catch {
    // Prompt state is best-effort UI state; a storage failure should not block the app.
  }
}

export function shouldOfferPwaPushPrompt(input: {
  readonly surface: PushPromptSurface;
  readonly hasRunningTurn: boolean;
  readonly pushSupported: boolean;
  readonly permission: NotificationPermission | "unsupported";
  readonly isSubscribed: boolean;
  readonly promptHandled: boolean;
}): boolean {
  if (input.surface === "other") {
    return false;
  }
  if (input.surface === "desktop-web" && !input.hasRunningTurn) {
    return false;
  }
  if (input.promptHandled) {
    return false;
  }
  if (!input.pushSupported) {
    return false;
  }
  if (input.permission === "denied" || input.permission === "unsupported") {
    return false;
  }
  if (input.isSubscribed) {
    return false;
  }
  return true;
}
