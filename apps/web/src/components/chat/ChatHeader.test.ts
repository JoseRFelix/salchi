import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetDevServerWindowForTests,
  openDevServerLink,
  shouldEnableDevServerButton,
  shouldShowOpenInPicker,
} from "./ChatHeader";
import type { DevServerLink } from "../../devServerLinks";

afterEach(() => {
  __resetDevServerWindowForTests();
  vi.unstubAllGlobals();
});

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
});

describe("openDevServerLink", () => {
  it("reuses the named browser tab while it is still available", () => {
    const openedWindow = {
      closed: false,
      focus: vi.fn(),
      location: {
        href: "",
      },
      opener: {},
    };
    const open = vi.fn(() => openedWindow);
    vi.stubGlobal("window", { open });

    openDevServerLink("http://localhost:5173/");
    openDevServerLink("http://localhost:3000/");

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("http://localhost:5173/", "salchi-dev-server-preview");
    expect(openedWindow.location.href).toBe("http://localhost:3000/");
    expect(openedWindow.focus).toHaveBeenCalledTimes(2);
    expect(openedWindow.opener).toBeNull();
  });
});

describe("shouldEnableDevServerButton", () => {
  it("requires at least one detected dev server link", () => {
    const link: DevServerLink = {
      url: "http://localhost:5173/",
      displayUrl: "http://localhost:5173",
      label: "Local localhost:5173",
      host: "localhost:5173",
      port: "5173",
    };

    expect(shouldEnableDevServerButton([])).toBe(false);
    expect(shouldEnableDevServerButton([link])).toBe(true);
  });
});
