import { afterEach, describe, expect, it } from "vitest";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";
import {
  claimClaudeLoginNotification,
  CLAUDE_LOGIN_NOTIFICATION_STORAGE_KEY,
} from "./claudeLoginNotification";

describe("claudeLoginNotification", () => {
  afterEach(() => {
    removeLocalStorageItem(CLAUDE_LOGIN_NOTIFICATION_STORAGE_KEY);
  });

  it("allows the Claude login notification only once across repeated mounts", () => {
    expect(claimClaudeLoginNotification()).toBe(true);
    expect(claimClaudeLoginNotification()).toBe(false);
    expect(claimClaudeLoginNotification()).toBe(false);
  });
});
