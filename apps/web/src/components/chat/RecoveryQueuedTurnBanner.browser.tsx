import "../../index.css";

import { MessageId } from "@salchi/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerBannerStack } from "./ComposerBannerStack";
import { createRecoveryQueuedTurnBannerItem } from "./RecoveryQueuedTurnBanner";

describe("RecoveryQueuedTurnBanner", () => {
  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1024, 768);
  });

  it("shows the recovery decision and captures its preview", async () => {
    await page.viewport(960, 540);
    const onSend = vi.fn();
    const onDiscard = vi.fn();
    const screen = await render(
      <main className="flex min-h-screen items-end bg-background px-8 pb-24 text-foreground">
        <div className="mx-auto w-full max-w-208">
          <ComposerBannerStack
            items={[
              createRecoveryQueuedTurnBannerItem({
                messageId: MessageId.make("preview-recovery-message"),
                text: "Continue with the reliability fixes and verify the reconnect path.",
                isSending: false,
                isDiscarding: false,
                onSend,
                onDiscard,
              }),
            ]}
          />
          <div className="h-28 rounded-[22px] border border-border bg-card shadow-sm" />
        </div>
      </main>,
    );

    try {
      await expect
        .element(page.getByText("Another message was queued during recovery — Send or discard?"))
        .toBeVisible();
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByRole("button", { name: "Discard" }).click();
      expect(onSend).toHaveBeenCalledOnce();
      expect(onDiscard).toHaveBeenCalledOnce();

      await page.screenshot({
        path: "../../../../../artifacts/recovery-queued-message-alert.png",
        element: page.getByRole("alert"),
      });
    } finally {
      await screen.unmount();
    }
  });
});
