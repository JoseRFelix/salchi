import { describe, expect, it } from "vitest";

import { isSafeVideoFileName, videoMimeTypeFromFileName } from "./videoMime.ts";

describe("videoMime", () => {
  it("infers safe video MIME types from file names", () => {
    expect(videoMimeTypeFromFileName("demo.MP4")).toBe("video/mp4");
    expect(videoMimeTypeFromFileName("capture.webm")).toBe("video/webm");
    expect(videoMimeTypeFromFileName("clip.mov")).toBe("video/quicktime");
    expect(videoMimeTypeFromFileName("notes.txt")).toBeNull();
  });

  it("identifies safe video file names", () => {
    expect(isSafeVideoFileName("screen-recording.m4v")).toBe(true);
    expect(isSafeVideoFileName("archive.zip")).toBe(false);
  });
});
