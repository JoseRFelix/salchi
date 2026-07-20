import "../../index.css";

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { PierreEntryIcon } from "./PierreEntryIcon";

describe("PierreEntryIcon", () => {
  it("renders resolved file icons from the Pierre sprite sheet", async () => {
    const screen = await render(
      <div>
        <PierreEntryIcon pathValue="package.json" kind="file" theme="dark" />
        <PierreEntryIcon pathValue="src/Button.tsx" kind="file" theme="dark" />
      </div>,
    );

    try {
      const icons = [...screen.container.querySelectorAll<SVGSVGElement>("svg[data-pierre-icon]")];
      expect(icons.map((icon) => icon.getAttribute("data-pierre-icon"))).toEqual([
        "salchi-file-icon-package-json",
        "file-tree-builtin-react",
      ]);
      expect(icons[1]?.getAttribute("data-icon-token")).toBe("react");
      expect(document.querySelectorAll("#salchi-pierre-file-icon-sprite")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("uses the lucide fallback for directories", async () => {
    const screen = await render(
      <PierreEntryIcon pathValue="src/components" kind="directory" theme="dark" />,
    );

    try {
      expect(screen.container.querySelector("svg[data-pierre-icon]")).toBeNull();
      expect(screen.container.querySelector("svg")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
