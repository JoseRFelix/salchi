import type { EnvironmentApi } from "@salchi/contracts";
import { EnvironmentId, ThreadId, TurnId } from "@salchi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "./environmentApi";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "./environments/primary";
import {
  setThreadCompletionAttention,
  supportsThreadCompletionAttention,
  threadCompletionAttentionTargetKey,
} from "./threadAttention";

const environmentId = EnvironmentId.make("environment-attention");

function writeDescriptor(completionAttention?: true): void {
  writePrimaryEnvironmentDescriptor({
    environmentId,
    label: "Attention test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "test",
    capabilities: {
      repositoryIdentity: true,
      ...(completionAttention ? { completionAttention } : {}),
    },
  });
}

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  vi.unstubAllGlobals();
});

describe("completion attention capability negotiation", () => {
  it("scopes in-flight acknowledgement identity across environments and threads", () => {
    const turnId = TurnId.make("turn-shared");

    expect(
      threadCompletionAttentionTargetKey({
        environmentId: EnvironmentId.make("environment-a"),
        threadId: ThreadId.make("thread-shared"),
        turnId,
      }),
    ).not.toBe(
      threadCompletionAttentionTargetKey({
        environmentId: EnvironmentId.make("environment-b"),
        threadId: ThreadId.make("thread-shared"),
        turnId,
      }),
    );
  });

  it("disables attention commands for a known legacy environment", async () => {
    const dispatchCommand = vi.fn(async () => ({ accepted: true }));
    vi.stubGlobal("window", {});
    writeDescriptor();
    __setEnvironmentApiOverrideForTests(environmentId, {
      orchestration: { dispatchCommand },
    } as unknown as EnvironmentApi);

    expect(supportsThreadCompletionAttention(environmentId)).toBe(false);
    await expect(
      setThreadCompletionAttention({
        operation: "acknowledge",
        environmentId,
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
      }),
    ).resolves.toBe(false);
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("dispatches when the current environment advertises support", async () => {
    const dispatchCommand = vi.fn(async () => ({ accepted: true }));
    vi.stubGlobal("window", {});
    writeDescriptor(true);
    __setEnvironmentApiOverrideForTests(environmentId, {
      orchestration: { dispatchCommand },
    } as unknown as EnvironmentApi);

    expect(supportsThreadCompletionAttention(environmentId)).toBe(true);
    await expect(
      setThreadCompletionAttention({
        operation: "mark-unread",
        environmentId,
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
      }),
    ).resolves.toBe(true);
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
  });
});
