import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createThreadNotificationAttentionController,
  isDocumentActivelyViewed,
} from "./threadNotificationAttention";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isDocumentActivelyViewed", () => {
  it("requires the document to be both visible and focused", () => {
    expect(isDocumentActivelyViewed({ visibilityState: "visible", hasFocus: () => true })).toBe(
      true,
    );
    expect(isDocumentActivelyViewed({ visibilityState: "visible", hasFocus: () => false })).toBe(
      false,
    );
    expect(isDocumentActivelyViewed({ visibilityState: "hidden", hasFocus: () => true })).toBe(
      false,
    );
  });
});

describe("createThreadNotificationAttentionController", () => {
  it("clears the focused thread immediately on a relevant state update and retries delivery races", async () => {
    vi.useFakeTimers();
    const clearThreadNotifications = vi.fn(async () => {});
    const controller = createThreadNotificationAttentionController({
      clearThreadNotifications,
      isActivelyViewed: () => true,
    });

    controller.acknowledgeCurrentState();
    await vi.advanceTimersByTimeAsync(0);
    expect(clearThreadNotifications).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9000);
    expect(clearThreadNotifications).toHaveBeenCalledTimes(4);
  });

  it("does not clear an unfocused thread", async () => {
    vi.useFakeTimers();
    const clearThreadNotifications = vi.fn(async () => {});
    const controller = createThreadNotificationAttentionController({
      clearThreadNotifications,
      isActivelyViewed: () => false,
    });

    controller.acknowledgeCurrentState();
    controller.acknowledgeAfterActivation();
    await vi.runAllTimersAsync();

    expect(clearThreadNotifications).not.toHaveBeenCalled();
  });

  it("waits five seconds before clearing after focus or visibility activation", async () => {
    vi.useFakeTimers();
    const clearThreadNotifications = vi.fn(async () => {});
    const controller = createThreadNotificationAttentionController({
      clearThreadNotifications,
      isActivelyViewed: () => true,
    });

    controller.acknowledgeAfterActivation();
    await vi.advanceTimersByTimeAsync(4999);
    expect(clearThreadNotifications).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(clearThreadNotifications).toHaveBeenCalledTimes(1);
  });

  it("cancels pending cleanup when disposed", async () => {
    vi.useFakeTimers();
    const clearThreadNotifications = vi.fn(async () => {});
    const controller = createThreadNotificationAttentionController({
      clearThreadNotifications,
      isActivelyViewed: () => true,
    });

    controller.acknowledgeAfterActivation();
    controller.dispose();
    await vi.runAllTimersAsync();

    expect(clearThreadNotifications).not.toHaveBeenCalled();
  });
});
