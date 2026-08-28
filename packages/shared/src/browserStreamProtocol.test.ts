import { ThreadId } from "@salchi/contracts";
import { describe, expect, it } from "vitest";

import {
  BROWSER_STREAM_FRAME_HEADER_BYTES,
  BROWSER_STREAM_UNKNOWN_TAB_INDEX,
  decodeBrowserStreamInput,
  decodeBrowserStreamServerMessage,
  encodeBrowserStreamFrame,
  encodeBrowserStreamInput,
  encodeBrowserStreamMeta,
} from "./browserStreamProtocol.ts";

describe("browser stream binary protocol", () => {
  const threadId = ThreadId.make("thread-protocol");

  it("round-trips a raw JPEG frame without base64 encoding", () => {
    const jpegBytes = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const encoded = encodeBrowserStreamFrame({
      seq: 0xf0_e1_d2_c3,
      width: 800,
      height: 600,
      tabIndexHint: BROWSER_STREAM_UNKNOWN_TAB_INDEX,
      jpegBytes,
    });

    expect(encoded.byteLength).toBe(BROWSER_STREAM_FRAME_HEADER_BYTES + jpegBytes.byteLength);
    expect(decodeBrowserStreamServerMessage(encoded)).toEqual({
      _tag: "Frame",
      frame: {
        seq: 0xf0_e1_d2_c3,
        width: 800,
        height: 600,
        tabIndexHint: BROWSER_STREAM_UNKNOWN_TAB_INDEX,
        jpegBytes,
      },
    });
  });

  it("round-trips status and tabs META messages", () => {
    const status = {
      _tag: "Status" as const,
      threadId,
      status: "crashed" as const,
      error: "Chromium exited",
    };
    const tabs = {
      _tag: "Tabs" as const,
      threadId,
      tabs: [{ targetId: "target-1", title: "Example", url: "https://example.com", active: true }],
    };

    expect(decodeBrowserStreamServerMessage(encodeBrowserStreamMeta(status))).toEqual({
      _tag: "Meta",
      event: status,
    });
    expect(decodeBrowserStreamServerMessage(encodeBrowserStreamMeta(tabs))).toEqual({
      _tag: "Meta",
      event: tabs,
    });
  });

  it("round-trips the existing browser input event union inside its target envelope", () => {
    const input = {
      targetId: "target-1",
      event: {
        _tag: "PointerDown" as const,
        x: 120.5,
        y: 80.25,
        button: "left" as const,
        clickCount: 1,
      },
    };

    expect(decodeBrowserStreamInput(encodeBrowserStreamInput(input))).toEqual(input);
  });

  it("rejects wrong versions, message directions, and invalid input payloads", () => {
    const wrongVersion = encodeBrowserStreamInput({
      targetId: "target-1",
      event: { _tag: "InsertText", text: "hello" },
    });
    wrongVersion[0] = 2;

    expect(() => decodeBrowserStreamInput(wrongVersion)).toThrow(/protocol version/);
    expect(() =>
      decodeBrowserStreamInput(
        encodeBrowserStreamMeta({
          _tag: "Status",
          threadId,
          status: "running",
        }),
      ),
    ).toThrow(/client browser stream message type/);

    const invalid = new TextEncoder().encode('{"targetId":"","event":{"_tag":"Nope"}}');
    const encoded = new Uint8Array(2 + invalid.byteLength);
    encoded.set([1, 3]);
    encoded.set(invalid, 2);
    expect(() => decodeBrowserStreamInput(encoded)).toThrow(/INPUT body is invalid/);
  });
});
