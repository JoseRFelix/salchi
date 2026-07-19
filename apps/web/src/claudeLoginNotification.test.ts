import { afterEach, describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
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

  it("repairs a corrupt persisted claim before suppressing later notifications", () => {
    setLocalStorageItem(CLAUDE_LOGIN_NOTIFICATION_STORAGE_KEY, "not-a-boolean", Schema.String);

    expect(claimClaudeLoginNotification()).toBe(true);
    expect(claimClaudeLoginNotification()).toBe(false);
  });
});
