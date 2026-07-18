import "../../index.css";

import { ApprovalRequestId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("makes remembered approval the primary action while retaining an explicit one-time choice", async () => {
    const onRespondToApproval = vi.fn().mockResolvedValue(undefined);
    const requestId = ApprovalRequestId.make("approval-request-1");
    const screen = await render(
      <ComposerPendingApprovalActions
        requestId={requestId}
        isResponding={false}
        onRespondToApproval={onRespondToApproval}
      />,
    );

    await page.getByRole("button", { name: "Approve and remember" }).click();
    expect(onRespondToApproval).toHaveBeenLastCalledWith(requestId, "acceptForSession");

    await page.getByRole("button", { name: "Allow once" }).click();
    expect(onRespondToApproval).toHaveBeenLastCalledWith(requestId, "accept");

    await screen.unmount();
  });
});
