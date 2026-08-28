import {
  BrowserInputEvent,
  BrowserViewportStatus,
  BrowserViewportTabs,
  type BrowserInputEvent as BrowserInputEventType,
  type BrowserViewportStatus as BrowserViewportStatusType,
  type BrowserViewportTabs as BrowserViewportTabsType,
} from "@salchi/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const BROWSER_STREAM_VERSION = 0x01;

export const BrowserStreamMessageType = {
  Frame: 0x01,
  Meta: 0x02,
  Input: 0x03,
} as const;

export const BROWSER_STREAM_FRAME_HEADER_BYTES = 11;
export const BROWSER_STREAM_MESSAGE_HEADER_BYTES = 2;
export const BROWSER_STREAM_UNKNOWN_TAB_INDEX = 0xff;

export interface BrowserStreamFrameMessage {
  readonly seq: number;
  readonly width: number;
  readonly height: number;
  readonly tabIndexHint: number;
  readonly jpegBytes: Uint8Array;
}

export interface BrowserStreamActivityMeta {
  readonly agentActive: boolean;
}

export type BrowserStreamMetaMessage =
  | BrowserViewportStatusType
  | BrowserViewportTabsType
  | BrowserStreamActivityMeta;

export interface BrowserStreamInputMessage {
  readonly targetId: string;
  readonly event: BrowserInputEventType;
}

export type BrowserStreamServerMessage =
  | { readonly _tag: "Frame"; readonly frame: BrowserStreamFrameMessage }
  | { readonly _tag: "Meta"; readonly event: BrowserStreamMetaMessage };

const BrowserStreamActivityMetaSchema = Schema.Struct({ agentActive: Schema.Boolean });
const BrowserStreamMetaSchema = Schema.Union([
  BrowserViewportTabs,
  BrowserViewportStatus,
  BrowserStreamActivityMetaSchema,
]);
const BrowserStreamInputSchema = Schema.Struct({
  targetId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1)),
  event: BrowserInputEvent,
});

const decodeMetaUnknown = Schema.decodeUnknownOption(BrowserStreamMetaSchema);
const decodeInputUnknown = Schema.decodeUnknownOption(BrowserStreamInputSchema);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function assertUnsignedInteger(value: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 0 and ${maximum.toString()}.`);
  }
}

function bytesOf(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function encodeJsonMessage(type: number, value: unknown): Uint8Array {
  const jsonBytes = textEncoder.encode(JSON.stringify(value));
  const encoded = new Uint8Array(BROWSER_STREAM_MESSAGE_HEADER_BYTES + jsonBytes.byteLength);
  encoded[0] = BROWSER_STREAM_VERSION;
  encoded[1] = type;
  encoded.set(jsonBytes, BROWSER_STREAM_MESSAGE_HEADER_BYTES);
  return encoded;
}

function decodeJsonBody(bytes: Uint8Array): unknown {
  if (bytes.byteLength <= BROWSER_STREAM_MESSAGE_HEADER_BYTES) {
    throw new Error("Browser stream JSON message has an empty body.");
  }
  return JSON.parse(textDecoder.decode(bytes.subarray(BROWSER_STREAM_MESSAGE_HEADER_BYTES)));
}

function requireProtocolHeader(bytes: Uint8Array): number {
  if (bytes.byteLength < BROWSER_STREAM_MESSAGE_HEADER_BYTES) {
    throw new Error("Browser stream message is shorter than its protocol header.");
  }
  if (bytes[0] !== BROWSER_STREAM_VERSION) {
    throw new Error(`Unsupported browser stream protocol version ${String(bytes[0])}.`);
  }
  return bytes[1] ?? -1;
}

export function encodeBrowserStreamFrame(frame: BrowserStreamFrameMessage): Uint8Array {
  assertUnsignedInteger(frame.seq, 0xffff_ffff, "Frame sequence");
  assertUnsignedInteger(frame.width, 0xffff, "Frame width");
  assertUnsignedInteger(frame.height, 0xffff, "Frame height");
  assertUnsignedInteger(frame.tabIndexHint, 0xff, "Frame tab index hint");

  const encoded = new Uint8Array(BROWSER_STREAM_FRAME_HEADER_BYTES + frame.jpegBytes.byteLength);
  const view = new DataView(encoded.buffer);
  encoded[0] = BROWSER_STREAM_VERSION;
  encoded[1] = BrowserStreamMessageType.Frame;
  view.setUint32(2, frame.seq, false);
  view.setUint16(6, frame.width, false);
  view.setUint16(8, frame.height, false);
  encoded[10] = frame.tabIndexHint;
  encoded.set(frame.jpegBytes, BROWSER_STREAM_FRAME_HEADER_BYTES);
  return encoded;
}

export function encodeBrowserStreamMeta(event: BrowserStreamMetaMessage): Uint8Array {
  return encodeJsonMessage(BrowserStreamMessageType.Meta, event);
}

export function encodeBrowserStreamInput(input: BrowserStreamInputMessage): Uint8Array {
  return encodeJsonMessage(BrowserStreamMessageType.Input, input);
}

export function decodeBrowserStreamServerMessage(
  input: ArrayBuffer | ArrayBufferView,
): BrowserStreamServerMessage {
  const bytes = bytesOf(input);
  const type = requireProtocolHeader(bytes);
  if (type === BrowserStreamMessageType.Frame) {
    if (bytes.byteLength <= BROWSER_STREAM_FRAME_HEADER_BYTES) {
      throw new Error("Browser stream frame has no JPEG payload.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      _tag: "Frame",
      frame: {
        seq: view.getUint32(2, false),
        width: view.getUint16(6, false),
        height: view.getUint16(8, false),
        tabIndexHint: bytes[10] ?? BROWSER_STREAM_UNKNOWN_TAB_INDEX,
        jpegBytes: bytes.subarray(BROWSER_STREAM_FRAME_HEADER_BYTES),
      },
    };
  }
  if (type === BrowserStreamMessageType.Meta) {
    const decoded = decodeMetaUnknown(decodeJsonBody(bytes));
    if (Option.isNone(decoded)) throw new Error("Browser stream META body is invalid.");
    return { _tag: "Meta", event: decoded.value };
  }
  throw new Error(`Unexpected server browser stream message type ${type.toString()}.`);
}

export function decodeBrowserStreamInput(
  input: ArrayBuffer | ArrayBufferView,
): BrowserStreamInputMessage {
  const bytes = bytesOf(input);
  const type = requireProtocolHeader(bytes);
  if (type !== BrowserStreamMessageType.Input) {
    throw new Error(`Unexpected client browser stream message type ${type.toString()}.`);
  }
  const decoded = decodeInputUnknown(decodeJsonBody(bytes));
  if (Option.isNone(decoded)) throw new Error("Browser stream INPUT body is invalid.");
  return decoded.value;
}
