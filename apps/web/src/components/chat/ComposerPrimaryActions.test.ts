import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposerPrimaryActions, formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

const renderRunningPrimaryActions = (input: {
  isInterrupting?: boolean;
  hasSendableContent?: boolean;
  isSendBusy?: boolean;
}) =>
  renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: false,
      pendingAction: null,
      isRunning: true,
      isInterrupting: input.isInterrupting ?? false,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: input.isSendBusy ?? false,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: input.hasSendableContent ?? false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});

describe("ComposerPrimaryActions stop button", () => {
  it("renders a disabled stopping affordance while interrupting", () => {
    const markup = renderRunningPrimaryActions({ isInterrupting: true });

    expect(markup).toContain('aria-label="Stopping generation"');
    expect(markup).toContain("disabled=");
    expect(markup).toContain("animate-spin");
  });

  it("keeps the normal stop action enabled before interruption is in flight", () => {
    const markup = renderRunningPrimaryActions({});

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain("disabled=");
    expect(markup).not.toContain("animate-spin");
  });

  it("replaces stop with the queue action when the composer has content", () => {
    const markup = renderRunningPrimaryActions({ hasSendableContent: true });

    expect(markup).toContain('aria-label="Queue message"');
    expect(markup).not.toContain('aria-label="Stop generation"');
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("shows queueing progress in the same primary action", () => {
    const markup = renderRunningPrimaryActions({
      hasSendableContent: true,
      isSendBusy: true,
    });

    expect(markup).toContain('aria-label="Queueing message"');
    expect(markup).not.toContain('aria-label="Stopping generation"');
    expect(markup).toContain("animate-spin");
  });
});
