import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

export const PWA_PUSH_PROMPT_HANDLED_STORAGE_KEY = "salchi:pwa-push-prompt-handled:v1";

const PwaPushPromptHandledSchema = Schema.Boolean;

export function isPwaPushPromptHandled(): boolean {
  try {
    return (
      getLocalStorageItem(PWA_PUSH_PROMPT_HANDLED_STORAGE_KEY, PwaPushPromptHandledSchema) === true
    );
  } catch {
    return false;
  }
}

export function markPwaPushPromptHandled(): void {
  try {
    setLocalStorageItem(PWA_PUSH_PROMPT_HANDLED_STORAGE_KEY, true, PwaPushPromptHandledSchema);
  } catch {
    // Prompt state is best-effort UI state; a storage failure should not block the app.
  }
}

export function shouldOfferPwaPushPrompt(input: {
  readonly isStandalonePwa: boolean;
  readonly pushSupported: boolean;
  readonly permission: NotificationPermission | "unsupported";
  readonly isSubscribed: boolean;
  readonly promptHandled: boolean;
}): boolean {
  if (!input.isStandalonePwa) {
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
