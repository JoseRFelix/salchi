# Browser use

The server owns one headless Chromium process per orchestration thread. Each process uses a
persistent profile under `~/.salchi/userdata/browser-profiles/<threadId>/`, may contain multiple
tabs, and is independent of provider-session reaping. Process and live URL state are intentionally
not recovered after a server restart.

Chromium is resolved from `SALCHI_BROWSER_PATH`, then the server setting, then Playwright's system
Chrome/Chromium channels. `playwright-core` never downloads a browser. The sandbox is enabled unless
`SALCHI_BROWSER_NO_SANDBOX=1`; shared-memory avoidance and a loopback-only CDP debug address are
always applied.

Viewport frames use CDP `Page.startScreencast` as JPEG quality 55 at a maximum width of 800 and
device scale factor 1. Frames are acknowledged immediately and written to a capacity-one latest
value mailbox. They travel only over the existing JSON Effect RPC WebSocket, never through
orchestration events or SQLite. Screencasting exists only while there is a subscriber; Chromium may
stay alive with none. A session idles out only after both CDP activity and the last viewport
subscriber have been absent for the configured 15-minute default.

Requests to the instance's own listening host and port and to the static metadata hosts
`169.254.169.254`, `metadata.google.internal`, and `fd00:ec2::254` are failed through CDP
interception and logged. The same page interception also covers clients attached through the agent
CDP proxy. Explicit stop, thread deletion, idle timeout, and server-scope shutdown close Playwright
gracefully and then ensure the Chromium process tree is gone. Unexpected process exit is observable
as `crashed` and is restarted only by an explicit start.

## Phase 2a: viewport UI

The web client provides the browser as a normal right-panel view. Frames stay in the component's
canvas renderer and are not stored in Zustand or persisted. The viewport subscription exists only
while that panel view is visible.

## Phase 2b: agent CDP access

Chromium also exposes a dynamically allocated remote-debugging port bound to `127.0.0.1`. Salchi
discovers and validates the browser websocket endpoint after launch. The raw
`ws://127.0.0.1:<port>/devtools/browser/...` value is retained server-side and appears only in the
owner-scoped `browser.getState` response.

Provider sessions receive one variable, gated by the `browserAgentAccessEnabled` server setting:

- `SALCHI_BROWSER_CDP_URL=ws://127.0.0.1:<port>/internal/browser/cdp/<threadId>/<token>`

Salchi injects this per-thread URL into the provider process environment automatically. The token
is random per provider session, embedded in the path because MCP clients accept a URL but cannot
supply an authorization header, and revoked with that provider session. The URL is stable across
browser crashes for the credential's lifetime. It is a proxy URL, not Chromium's raw CDP URL, so
provider startup remains lazy: accepting a websocket connection starts or reuses the thread browser
and then pipes CDP frames in both directions.

The proxy uses a dedicated listener bound by the kernel to `127.0.0.1:0`; it is not mounted on
Salchi's public listener or Tailscale Serve. It rejects non-loopback peers, forwarding headers,
unknown thread/token pairs, query strings, and ordinary HTTP requests. Multiple proxy connections
may attach independently to Chromium's browser endpoint. Closing either side closes only that pipe,
not the browser. Browser stop, thread deletion, crash, or server shutdown closes the Chromium side;
connecting again through a still-valid stable URL lazily relaunches after a crash. Proxy connection
presence, a periodic heartbeat, and proxied traffic feed the browser idle controller, so an
attached agent is not stopped while it is working. The tokenized URL is capability material and is
not logged at info level.

Tabs created by an external CDP client enter the same persistent browser context. Its `page` event
installs the navigation guard and publishes the tab to the viewport UI. The viewport's independent
CDP session and concurrent agent clients coexist on Chromium's multi-client browser endpoint.

### Automatic MCP registration

Provider sessions require no user MCP configuration. Salchi pins `@playwright/mcp` 0.0.74 as a
server dependency, resolves its installed `cli.js` once per Salchi process, and launches it with
the verified `--cdp-endpoint` flag. This keeps provider startup independent of an `npx` network
fetch. Version 0.0.74 is the known-good release on Playwright's 1.60 line already used by Salchi;
newer MCP releases would pull a separate newer Playwright alpha into the server. Package resolution
is best-effort: failure logs a warning, omits only the browser MCP and its behavioral instruction,
and lets the provider session start normally.

The MCP server name is consistently `salchi-browser`. When it is registered, providers also
receive a short instruction to use those tools for browsing, not launch another browser, and
remember that the user can see the viewport live. Registration follows each provider's native
configuration seam:

- Claude receives a stdio entry in SDK `query` options beside the existing in-process `salchi`
  server; the preset system prompt uses its `append` field.
- Codex receives an `mcp_servers.salchi-browser` override in both `thread/start` and
  `thread/resume`; this request-scoped config does not materialize or mutate `CODEX_HOME`. The same
  definition is used by recoverable resume-to-new-thread fallback. Its existing collaboration-mode
  developer instructions carry the browsing instruction.
- Cursor and Grok receive a second ACP stdio `mcpServers` entry in every `session/new` and
  `session/load` path. The existing in-process Salchi MCP server's initialization instructions
  carry the browsing instruction.
- A locally spawned OpenCode server receives a per-process `OPENCODE_CONFIG_CONTENT` with a local
  MCP definition, and per-turn `system` context carries the instruction. Externally configured
  OpenCode server URLs remain intentionally unsupported for automatic registration because Salchi
  neither owns their process config nor mutates user config.

All registration and browser instructions are gated by `browserAgentAccessEnabled`. The provider
process and its MCP child also receive `SALCHI_BROWSER_CDP_URL`; custom setups may continue to use
the stable proxy directly. For example, the equivalent pinned manual Playwright configuration is:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "sh",
      "args": [
        "-lc",
        "exec npx -y @playwright/mcp@0.0.74 --cdp-endpoint \"$SALCHI_BROWSER_CDP_URL\""
      ]
    }
  }
}
```

The equivalent one-liner is:

```sh
npx -y @playwright/mcp@0.0.74 --cdp-endpoint "$SALCHI_BROWSER_CDP_URL"
```

Verified against `chrome-devtools-mcp` 1.8.0, its flag is `--wsEndpoint` (also exposed as the
`--ws-endpoint` alias):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "sh",
      "args": [
        "-lc",
        "exec npx -y chrome-devtools-mcp@latest --wsEndpoint \"$SALCHI_BROWSER_CDP_URL\""
      ]
    }
  }
}
```

```sh
npx -y chrome-devtools-mcp@latest --wsEndpoint "$SALCHI_BROWSER_CDP_URL"
```

Salchi itself does not invoke either `npx` command above; they are examples only for custom setups.
Phase 2b deliberately does not add a `salchi/*` browser tool or alter dynamic-tool handling.

## Phase 3 manual interaction

The viewport remains view-only until the user explicitly enables **Interact**. Hiding the panel,
switching views or threads, closing the responsive sheet, stopping/crashing the browser, or losing
authorization disables interaction. Pointer, wheel, keyboard, and composed text events travel over
the owner-scoped `browser.dispatchInput` RPC and are accepted only for the active tab.

The browser viewport is fixed at 800×600 with device scale factor 1. The client inverts the canvas
aspect-fit transform, including letterbox offsets and device-pixel-ratio backing scale, into streamed
frame coordinates. The server clamps those coordinates to the most recently observed frame size
before dispatching through the tab's existing CDP session. Each successful input records CDP
activity, and a per-browser rolling limit admits at most 200 events in any one-second window.

Touch uses a deliberate hybrid convention: a quick tap clicks, moving one finger scrolls by
emitting wheel deltas, and holding for 450 ms before moving enters click-drag mode. Desktop pointer
moves are coalesced to one per animation frame. Desktop keyboard events go to a focused interactive
canvas; the mobile keyboard button focuses a hidden text input that supports composed text plus
Enter and Backspace. File pickers, clipboard synchronization, full IME fidelity, and multi-touch
gestures remain out of scope.

Manual verification:

1. Have an attached agent navigate to a page while the Browser panel is open.
2. Enable **Interact**, click a link or cookie banner, and verify the agent remains attached.
3. Scroll with a mouse wheel or a one-finger touch drag.
4. Focus a text field and type with the desktop keyboard or the panel keyboard button on mobile.
