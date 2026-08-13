import { describe, expect, it } from "vitest";

import { buildAttachmentDownloadUrl } from "./ExpandedImagePreview";

describe("buildAttachmentDownloadUrl", () => {
  it("adds a download query parameter to attachment URLs", () => {
    expect(buildAttachmentDownloadUrl("/attachments/image-1")).toBe(
      "/attachments/image-1?download=1",
    );
    expect(
      buildAttachmentDownloadUrl("https://example.test/attachments/image-1?token=abc#view"),
    ).toBe("https://example.test/attachments/image-1?token=abc&download=1#view");
  });
});
