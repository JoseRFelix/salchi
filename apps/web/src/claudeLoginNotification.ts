import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLAUDE_LOGIN_NOTIFICATION_STORAGE_KEY = "t3code:claude-login-notification-shown:v1";

/**
 * Persistently claim the one Claude login notification allowed for this browser profile.
 * The write happens before the toast is created so React effect replays and duplicate
 * component mounts cannot enqueue a second notification.
 */
export function claimClaudeLoginNotification(): boolean {
  try {
    if (getLocalStorageItem(CLAUDE_LOGIN_NOTIFICATION_STORAGE_KEY, Schema.Boolean) === true) {
      return false;
    }
    setLocalStorageItem(CLAUDE_LOGIN_NOTIFICATION_STORAGE_KEY, true, Schema.Boolean);
    return true;
  } catch {
    // A denied or corrupt localStorage should not break the sidebar. The component's
    // in-memory guard still prevents duplicate notifications for the current mount.
    return true;
  }
}
