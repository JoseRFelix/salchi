import { describe, expect, it } from "vitest";

import {
  inferSupportedAttachmentType,
  normalizeAttachmentMimeType,
  PDF_MIME_TYPE,
} from "./attachmentMime.ts";

describe("attachmentMime", () => {
  it("detects PDFs by MIME type or file extension", () => {
    expect(inferSupportedAttachmentType({ type: PDF_MIME_TYPE, name: "report" })).toBe("pdf");
    expect(inferSupportedAttachmentType({ type: "", name: "report.pdf" })).toBe("pdf");
  });

  it("normalizes empty MIME type for PDF file names", () => {
    expect(normalizeAttachmentMimeType({ type: "", name: "report.pdf" })).toBe(PDF_MIME_TYPE);
  });

  it("detects image MIME types", () => {
    expect(inferSupportedAttachmentType({ type: "image/png", name: "image.png" })).toBe("image");
  });
});
