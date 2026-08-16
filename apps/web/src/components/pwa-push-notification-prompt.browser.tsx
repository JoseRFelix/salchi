import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PwaPushNotificationPrompt } from "./pwa-push-notification-prompt";

const pushMocks = vi.hoisted(() => ({
  enable: vi.fn(),
  getCurrentSubscription: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("../env", () => ({
  isStandalonePwa: () => false,
}));

vi.mock("../hooks/useMediaQuery", () => ({
  useIsMobile: () => false,
}));

vi.mock("../push/notifications", () => ({
  enablePushNotifications: pushMocks.enable,
  getBrowserPushSupport: () => ({ supported: true, reason: "supported" }),
  getCurrentPushSubscription: pushMocks.getCurrentSubscription,
  getNotificationPermission: () => "default",
  preparePushNotifications: pushMocks.prepare,
}));

beforeEach(() => {
  vi.useFakeTimers();
  pushMocks.enable.mockReset();
  pushMocks.getCurrentSubscription.mockReset().mockResolvedValue(null);
  pushMocks.prepare.mockReset().mockResolvedValue({
    applicationServerKey: new Uint8Array([1, 2, 3]),
    registration: {},
  });
  localStorage.removeItem("salchi:pwa-push-prompt-handled:v1");
  localStorage.removeItem("salchi:push-prompt-dismissed-at:v2");
});

afterEach(() => {
  vi.useRealTimers();
});

it("waits for a running turn before showing the desktop web prompt", async () => {
  const screen = await render(<PwaPushNotificationPrompt hasRunningTurn={false} />);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(pushMocks.prepare).not.toHaveBeenCalled();

  await screen.rerender(<PwaPushNotificationPrompt hasRunningTurn />);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(pushMocks.prepare).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => {
    expect(pushMocks.prepare).toHaveBeenCalledOnce();
  });
  await expect
    .element(page.getByRole("dialog"))
    .toHaveTextContent("Switch tabs or windows while this turn runs.");
});
