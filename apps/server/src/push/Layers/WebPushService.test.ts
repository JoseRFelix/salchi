import { EnvironmentId, ThreadId } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import { normalizeWebPushPayloadForTest } from "./WebPushService.ts";

describe("normalizeWebPushPayloadForTest", () => {
  it("preserves completion attention metadata through payload sanitization", () => {
    expect(
      normalizeWebPushPayloadForTest({
        title: "Completed thread",
        body: "Done",
        url: "/environment-local/thread-1",
        tag: "thread:thread-1:turn:turn-1",
        completion: {
          environmentId: EnvironmentId.make("environment-local"),
          threadId: ThreadId.make("thread-1"),
          completionId: "turn-1",
        },
        unreadCompletionState: {
          environmentId: EnvironmentId.make("environment-local"),
          sequence: 42,
          count: 3,
        },
        completionAttentionVersion: 2,
      }),
    ).toEqual({
      title: "Completed thread",
      body: "Done",
      url: "/environment-local/thread-1",
      tag: "thread:thread-1:turn:turn-1",
      completion: {
        environmentId: "environment-local",
        threadId: "thread-1",
        completionId: "turn-1",
      },
      unreadCompletionState: {
        environmentId: "environment-local",
        sequence: 42,
        count: 3,
      },
      completionAttentionVersion: 2,
    });
  });
});
