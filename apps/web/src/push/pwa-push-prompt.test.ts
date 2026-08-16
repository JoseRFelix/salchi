import { describe, expect, it } from "vitest";

import {
  isPushPromptDismissalActive,
  PUSH_PROMPT_DISMISS_COOLDOWN_MS,
  shouldOfferPwaPushPrompt,
} from "./pwa-push-prompt";

const eligibleInput = {
  surface: "standalone-pwa" as const,
  hasRunningTurn: false,
  pushSupported: true,
  permission: "default" as NotificationPermission,
  isSubscribed: false,
  promptHandled: false,
};

describe("shouldOfferPwaPushPrompt", () => {
  it("offers the prompt for an eligible standalone PWA launch", () => {
    expect(shouldOfferPwaPushPrompt(eligibleInput)).toBe(true);
  });

  it("offers the prompt in desktop web while a turn is running", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        surface: "desktop-web",
        hasRunningTurn: true,
      }),
    ).toBe(true);
  });

  it("does not offer the desktop prompt before a turn is running", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        surface: "desktop-web",
      }),
    ).toBe(false);
  });

  it("does not offer the prompt on other web surfaces", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        surface: "other",
        hasRunningTurn: true,
      }),
    ).toBe(false);
  });

  it("does not offer the prompt after it was handled", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        promptHandled: true,
      }),
    ).toBe(false);
  });

  it("does not offer the prompt when push is unsupported", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        pushSupported: false,
      }),
    ).toBe(false);
  });

  it("does not offer the prompt when permission is denied", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        permission: "denied",
      }),
    ).toBe(false);
  });

  it("does not offer the prompt when permission is unsupported", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        permission: "unsupported",
      }),
    ).toBe(false);
  });

  it("does not offer the prompt when already subscribed", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        isSubscribed: true,
      }),
    ).toBe(false);
  });

  it("offers the prompt when permission was already granted but not subscribed", () => {
    expect(
      shouldOfferPwaPushPrompt({
        ...eligibleInput,
        permission: "granted",
      }),
    ).toBe(true);
  });
});

describe("isPushPromptDismissalActive", () => {
  const now = Date.UTC(2026, 7, 16);

  it("keeps a recent dismissal active", () => {
    expect(isPushPromptDismissalActive(now - PUSH_PROMPT_DISMISS_COOLDOWN_MS + 1, now)).toBe(true);
  });

  it("allows the prompt again after the cooldown", () => {
    expect(isPushPromptDismissalActive(now - PUSH_PROMPT_DISMISS_COOLDOWN_MS, now)).toBe(false);
  });

  it("ignores missing, invalid, and future timestamps", () => {
    expect(isPushPromptDismissalActive(null, now)).toBe(false);
    expect(isPushPromptDismissalActive(Number.NaN, now)).toBe(false);
    expect(isPushPromptDismissalActive(now + 1, now)).toBe(false);
  });
});
