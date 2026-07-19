import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { Sidebar, SidebarProvider, SidebarTrigger } from "./sidebar";
import { ToastProvider, toastManager } from "./toast";
import { usePwaServiceWorkerUpdateStore } from "../../pwa/serviceWorkerUpdateState";

vi.mock("@tanstack/react-router", () => ({
  useParams: (options?: { select?: (params: Record<string, string | undefined>) => unknown }) =>
    options?.select ? options.select({}) : {},
}));

function MobileSidebarHarness() {
  return (
    <ToastProvider>
      <SidebarProvider>
        <button data-testid="outside-control" type="button">
          Outside control
        </button>
        <Sidebar collapsible="offcanvas" side="left">
          <div className="p-4">
            <p>Mobile sidebar content</p>
            <button
              type="button"
              onClick={() => {
                toastManager.add({
                  type: "success",
                  title: "Sidebar toast",
                  description: "Dismiss me",
                });
              }}
            >
              Show toast
            </button>
          </div>
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>
    </ToastProvider>
  );
}

function expectElementInside(container: Element, element: Element) {
  const containerBox = container.getBoundingClientRect();
  const elementBox = element.getBoundingClientRect();

  expect(elementBox.left).toBeGreaterThanOrEqual(containerBox.left);
  expect(elementBox.top).toBeGreaterThanOrEqual(containerBox.top);
  expect(elementBox.right).toBeLessThanOrEqual(containerBox.right);
  expect(elementBox.bottom).toBeLessThanOrEqual(containerBox.bottom);
}

describe("mobile Sidebar", () => {
  afterEach(async () => {
    toastManager.close();
    usePwaServiceWorkerUpdateStore.setState(usePwaServiceWorkerUpdateStore.getInitialState(), true);
    document.body.innerHTML = "";
    await page.viewport(1024, 768);
  });

  it("keeps the historical loading-indicator position on the compact trigger", async () => {
    await page.viewport(390, 700);
    usePwaServiceWorkerUpdateStore.getState().setCheckPhase("checking");
    const screen = await render(<MobileSidebarHarness />);

    try {
      const trigger = document.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
      const icon = document.querySelector<SVGElement>(
        '[data-slot="sidebar-trigger"] > svg:not([data-slot])',
      );
      const loadingIndicator = document.querySelector<SVGElement>(
        '[data-slot="sidebar-trigger-loading-indicator"]',
      );

      expect(icon).not.toBeNull();
      expect(trigger).not.toBeNull();
      expect(loadingIndicator).not.toBeNull();

      const triggerBox = trigger!.getBoundingClientRect();
      const iconBox = icon!.getBoundingClientRect();
      const loadingBox = loadingIndicator!.getBoundingClientRect();
      expect(Math.abs(loadingBox.top - triggerBox.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(loadingBox.right - triggerBox.right)).toBeLessThanOrEqual(1);
      expect(loadingBox.top).toBeLessThan(iconBox.top);
      expect(loadingBox.right).toBeGreaterThan(iconBox.right);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the historical available-update position on the compact trigger", async () => {
    await page.viewport(390, 700);
    usePwaServiceWorkerUpdateStore.getState().showUpdateAvailable(async () => {});
    const screen = await render(<MobileSidebarHarness />);

    try {
      const trigger = document.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
      const icon = document.querySelector<SVGElement>(
        '[data-slot="sidebar-trigger"] > svg:not([data-slot])',
      );
      const updateIndicator = document.querySelector<HTMLElement>(
        '[data-slot="sidebar-trigger-update-indicator"]',
      );

      expect(trigger).not.toBeNull();
      expect(icon).not.toBeNull();
      expect(updateIndicator).not.toBeNull();
      expectElementInside(trigger!, updateIndicator!);

      const iconBox = icon!.getBoundingClientRect();
      const updateBox = updateIndicator!.getBoundingClientRect();
      expect(updateBox.top).toBeLessThan(iconBox.top);
      expect(updateBox.right).toBeGreaterThan(iconBox.right);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the mobile sidebar open when a toast dismissal starts as an outside press", async () => {
    await page.viewport(390, 700);
    const screen = await render(<MobileSidebarHarness />);

    try {
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await expect.element(page.getByText("Mobile sidebar content")).toBeVisible();

      await page.getByRole("button", { name: "Show toast" }).click();
      await expect.element(page.getByText("Sidebar toast")).toBeVisible();

      await page.getByRole("button", { name: "Dismiss notification" }).click();

      await expect.element(page.getByText("Mobile sidebar content")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("still closes the mobile sidebar on ordinary outside presses", async () => {
    await page.viewport(390, 700);
    const screen = await render(<MobileSidebarHarness />);

    try {
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await expect.element(page.getByText("Mobile sidebar content")).toBeVisible();

      document.querySelector<HTMLButtonElement>('[data-testid="outside-control"]')?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector('[data-mobile="true"][data-sidebar="sidebar"]')).toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });
});
