import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLAUDE_LOGIN_NOTIFICATION_STORAGE_KEY = "salchi:claude-login-notification-shown:v1";

function persistClaudeLoginNotificationClaim(): true {
  try {
    setLocalStorageItem(CLAUDE_LOGIN_NOTIFICATION_STORAGE_KEY, true, Schema.Boolean);
  } catch {
    // Storage denial must not break the sidebar. The component-level guard still
    // limits the notification to once for the current mount.
  }
  return true;
}

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
  } catch {
    // Replace corrupt persisted data so the one-time claim remains durable on
    // subsequent reloads whenever localStorage itself is still writable.
    return persistClaudeLoginNotificationClaim();
  }
  return persistClaudeLoginNotificationClaim();
}
