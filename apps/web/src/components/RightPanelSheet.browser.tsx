import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useEffect, useState } from "react";

import { RightPanelSheet } from "./RightPanelSheet";
import { ToastProvider, toastManager } from "./ui/toast";

vi.mock("@tanstack/react-router", () => ({
  useParams: (options?: { select?: (params: Record<string, string | undefined>) => unknown }) =>
    options?.select ? options.select({}) : {},
}));

function RightPanelSheetHarness(props: { onClose: () => void }) {
  const [open, setOpen] = useState(true);

  return (
    <ToastProvider>
      <button data-testid="outside-control" type="button">
        Outside control
      </button>
      <RightPanelSheet
        open={open}
        onClose={() => {
          props.onClose();
          setOpen(false);
        }}
      >
        <div className="p-4">
          <p>Right panel content</p>
          <button
            type="button"
            onClick={() => {
              toastManager.add({
                type: "success",
                title: "Added to input",
                description: "@src/App.tsx",
              });
            }}
          >
            Add preview file
          </button>
        </div>
      </RightPanelSheet>
    </ToastProvider>
  );
}

function SheetContentLifecycle(props: { onDismiss: () => void; onUnmount: () => void }) {
  useEffect(() => props.onUnmount, [props.onUnmount]);
  return (
    <div data-testid="gesture-sheet-content">
      <p>Gesture sheet content</p>
      <button type="button" onClick={props.onDismiss}>
        Simulate gesture dismissal
      </button>
    </div>
  );
}

function GestureDismissalHarness(props: { onContentUnmount: () => void }) {
  const [open, setOpen] = useState(true);

  return (
    <RightPanelSheet open={open} onClose={() => setOpen(false)}>
      {open ? (
        <SheetContentLifecycle
          onDismiss={() => setOpen(false)}
          onUnmount={props.onContentUnmount}
        />
      ) : null}
    </RightPanelSheet>
  );
}

describe("RightPanelSheet", () => {
  afterEach(() => {
    toastManager.close();
    document.body.innerHTML = "";
  });

  it("keeps the sheet open when a toast dismissal starts as an outside press", async () => {
    const onClose = vi.fn();
    const screen = await render(<RightPanelSheetHarness onClose={onClose} />);

    try {
      await page.getByRole("button", { name: "Add preview file" }).click();
      await expect.element(page.getByText("Added to input")).toBeVisible();

      await page.getByRole("button", { name: "Dismiss notification" }).click();

      expect(onClose).not.toHaveBeenCalled();
      await expect.element(page.getByText("Right panel content")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("still closes the sheet on ordinary outside presses", async () => {
    const onClose = vi.fn();
    const screen = await render(<RightPanelSheetHarness onClose={onClose} />);

    try {
      document.querySelector<HTMLButtonElement>('[data-testid="outside-control"]')?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
        }),
      );

      await vi.waitFor(() => {
        expect(onClose).toHaveBeenCalledOnce();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps mobile content mounted until a gesture-driven close animation finishes", async () => {
    await page.viewport(390, 844);
    const onContentUnmount = vi.fn();
    const screen = await render(<GestureDismissalHarness onContentUnmount={onContentUnmount} />);

    try {
      await page.getByRole("button", { name: "Simulate gesture dismissal" }).click();

      expect(onContentUnmount).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="gesture-sheet-content"]')).not.toBeNull();

      await vi.waitFor(
        () => {
          expect(onContentUnmount).toHaveBeenCalledOnce();
          expect(document.querySelector('[data-testid="gesture-sheet-content"]')).toBeNull();
        },
        { timeout: 2_000 },
      );
    } finally {
      await screen.unmount();
    }
  });
});
