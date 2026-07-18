import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerDictationProcessingIndicator } from "./ComposerDictationProcessingIndicator";

describe("ComposerDictationProcessingIndicator", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows installation progress without a spinner while the model downloads", async () => {
    const screen = await render(
      <ComposerDictationProcessingIndicator
        status={{
          configured: true,
          state: "downloading-model",
          downloadedBytes: 42,
          totalBytes: 100,
          message: null,
        }}
      />,
    );

    try {
      await expect.element(page.getByRole("progressbar")).toBeVisible();
      await expect.element(page.getByText("42%")).toBeVisible();
      expect(document.querySelector('[data-chat-composer-dictation-spinner="true"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("shows only the spinner when the model is ready", async () => {
    const screen = await render(
      <ComposerDictationProcessingIndicator
        status={{
          configured: true,
          state: "ready",
          downloadedBytes: null,
          totalBytes: null,
          message: null,
        }}
      />,
    );

    try {
      expect(document.querySelector('[role="progressbar"]')).toBeNull();
      expect(
        document.querySelector('[data-chat-composer-dictation-spinner="true"]'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
