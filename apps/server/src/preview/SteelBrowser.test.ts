import { describe, expect, it } from "vite-plus/test";

import {
  buildSteelViewerUrl,
  rewriteSteelUrlToBase,
  rewriteSteelWebSocketUrl,
} from "./SteelBrowser.ts";

describe("SteelBrowser URL helpers", () => {
  it("rewrites Steel viewer URLs onto the configured public base", () => {
    expect(
      rewriteSteelUrlToBase(
        "http://0.0.0.0:3000/v1/sessions/debug?pageIndex=0",
        "https://steel.example.test",
      ),
    ).toBe("https://steel.example.test/v1/sessions/debug?pageIndex=0");
  });

  it("builds an interactive viewer URL", () => {
    expect(
      buildSteelViewerUrl("http://localhost:3000/v1/sessions/debug", "https://steel.example.test"),
    ).toBe(
      "https://steel.example.test/v1/sessions/debug?showControls=false&interactive=true&theme=dark",
    );
  });

  it("rewrites websocket URLs for server-side CDP connections", () => {
    expect(rewriteSteelWebSocketUrl("ws://0.0.0.0:3000/", "http://127.0.0.1:3000")).toBe(
      "ws://127.0.0.1:3000/",
    );
    expect(rewriteSteelWebSocketUrl("ws://0.0.0.0:3000/", "https://steel.example.test")).toBe(
      "wss://steel.example.test/",
    );
  });
});
