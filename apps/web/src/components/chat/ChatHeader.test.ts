import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when activeProjectName is an empty string", () => {
    // Empty string is falsy — treated the same as no project.
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when both primaryEnvironmentId is null and there is no project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: EnvironmentId.make("environment-x"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("shows the picker when the thread environment matches the primary environment exactly", () => {
    const env = EnvironmentId.make("environment-exact");
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "my-project",
        activeThreadEnvironmentId: env,
        primaryEnvironmentId: env,
      }),
    ).toBe(true);
  });
});
