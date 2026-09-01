import { describe, expect, it } from "vitest";

import { dispatchInboxThreadMenuAction } from "./InboxThreadRow";

describe("dispatchInboxThreadMenuAction", () => {
  it("stops row navigation and dismisses the menu before dispatching snooze", () => {
    const calls: string[] = [];

    dispatchInboxThreadMenuAction(
      { stopPropagation: () => calls.push("stop propagation") },
      "snooze-hour",
      {
        dismiss: () => calls.push("dismiss menu"),
        onAction: (action) => calls.push(`dispatch ${action}`),
      },
    );

    expect(calls).toEqual(["stop propagation", "dismiss menu", "dispatch snooze-hour"]);
  });
});
