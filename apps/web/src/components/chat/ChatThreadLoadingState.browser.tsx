import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarProvider } from "../ui/sidebar";
import { ChatThreadLoadingState } from "./ChatThreadLoadingState";

afterEach(async () => {
  document.documentElement.classList.remove("dark");
});

async function renderLoadingState(width: number, height: number) {
  await page.viewport(width, height);
  document.documentElement.classList.add("dark");
  return render(
    <SidebarProvider className="h-dvh min-h-0">
      <ChatThreadLoadingState />
    </SidebarProvider>,
  );
}

it("renders a chat-accurate loading shell on desktop", async () => {
  const screen = await renderLoadingState(1_200, 800);

  try {
    await expect
      .element(page.getByRole("status", { name: "Loading conversation..." }))
      .toBeVisible();
    await expect.element(page.getByTestId("chat-thread-loading-header")).toBeVisible();
    await expect.element(page.getByTestId("chat-thread-loading-timeline")).toBeVisible();
    await expect.element(page.getByTestId("chat-thread-loading-composer")).toBeVisible();
    expect(page.getByTestId("chat-thread-loading-assistant-message").elements()).toHaveLength(7);
    expect(page.getByTestId("chat-thread-loading-user-message").elements()).toHaveLength(7);
    expect(screen.container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(40);
  } finally {
    await screen.unmount();
  }
});

it("preserves the compact chat shell on mobile", async () => {
  const screen = await renderLoadingState(390, 844);

  try {
    const state = screen.container.querySelector<HTMLElement>(
      '[data-testid="chat-thread-loading-state"]',
    );
    const composer = screen.container.querySelector<HTMLElement>(
      '[data-testid="chat-thread-loading-composer"]',
    );
    expect(state).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(state!.getBoundingClientRect().width).toBe(390);
    expect(state!.getBoundingClientRect().height).toBe(844);
    await expect.element(page.getByRole("button", { name: "Toggle Sidebar" })).toBeVisible();
    expect(page.getByTestId("chat-thread-loading-assistant-message").elements()).toHaveLength(7);
    expect(page.getByTestId("chat-thread-loading-user-message").elements()).toHaveLength(7);
  } finally {
    await screen.unmount();
  }
});
