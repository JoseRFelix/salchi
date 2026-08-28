# Browser use

The server owns one headless Chromium process per root orchestration thread. Browser API and agent
proxy inputs follow both `parentThreadId` and `createdByThreadId` ancestry before lookup, so
materialized children and provider-created virtual sessions share the root process and profile.
Only a thread with neither relationship is accepted as an owner. Each process uses a
persistent profile under `~/.salchi/userdata/browser-profiles/<threadId>/`, may contain multiple
tabs, and is independent of provider-session reaping. Process and live URL state are intentionally
not recovered after a server restart. Startup warns about legacy profile directories that no
longer correspond to a real root orchestration thread; it does not delete or migrate them.
Although ownership stays root-keyed internally, browser API snapshots and viewport metadata retain
the caller's requested thread id so child-thread panels can safely discard genuinely stale events.

Chromium is resolved from `SALCHI_BROWSER_PATH`, then the server setting, then Playwright's system
Chrome/Chromium channels. `playwright-core` never downloads a browser. The sandbox is enabled unless
`SALCHI_BROWSER_NO_SANDBOX=1`; shared-memory avoidance and a loopback-only CDP debug address are
always applied.

Viewport frames use CDP `Page.startScreencast` as JPEG quality 55 at a maximum width of 800 and
device scale factor 1. Frames are acknowledged immediately and written to a capacity-one latest
value mailbox. The web client receives them over the dedicated binary browser stream described
below; the original JSON Effect RPC stream remains as a compatibility API. Frames never enter
orchestration events or SQLite. Screencasting exists only while there is a subscriber; Chromium may
stay alive with none. A session idles out only after both CDP activity and the last viewport
subscriber have been absent for the configured 15-minute default.

Requests to the instance's own listening host and port and to the static metadata hosts
`169.254.169.254`, `metadata.google.internal`, and `fd00:ec2::254` are failed through CDP
interception and logged. `Fetch.enable` contains only patterns for those hosts plus the Salchi
host/port and loopback aliases; it never uses a catch-all pattern, so ordinary documents and
subresources never pause in Node. The same page interception also covers clients attached through
the agent CDP proxy. Explicit stop, thread deletion, idle timeout, and server-scope shutdown close Playwright
gracefully and then ensure the Chromium process tree is gone. Unexpected process exit is observable
as `crashed` and is restarted only by an explicit start.

## Phase 2a: viewport UI

The web client provides the browser as a normal right-panel view. Frames stay in the component's
canvas renderer and are not stored in Zustand or persisted. The viewport subscription exists only
while that panel view is visible. Its browser-style address bar exposes back, forward, reload, and
direct navigation through owner-scoped unary browser RPCs.

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

The viewport enters interaction mode on the first valid click or tap and forwards that same gesture;
there is no separate interaction control. Hiding the panel, switching views or threads, closing the
responsive sheet, stopping/crashing the browser, or losing authorization disables interaction.
Pointer, wheel, keyboard, and composed text events use the existing dispatch-input event union and
are accepted only for the active tab. Phase 4 sends panel input over the binary browser socket; the
owner-scoped `browser.dispatchInput` RPC remains available for programmatic callers.

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
2. Click a link or cookie banner in the viewport and verify the first click is forwarded while the
   agent remains attached.
3. Scroll with a mouse wheel or a one-finger touch drag.
4. Focus a text field and type with the desktop keyboard or the panel keyboard button on mobile.

## Phase 4 low-latency browser stream

The public Salchi listener now serves
`ws(s)://<salchi-host>/browser-stream/<threadId>?ticket=<short-lived-ticket>`. It uses the same
websocket-ticket exchange as `/ws`, enforces `browser:operate` before upgrading, and is intentionally
reachable through the same Tailscale Serve path as `/ws` so a remote phone can use it. Each raw
connection owns one ordinary viewport subscription, so multiple phones/desktops compose with the
existing first-subscriber/last-unsubscriber screencast and idle-controller behavior.

Protocol version 1 starts every binary message with a version byte and a type byte. `FRAME` carries
sequence, dimensions, a tab-index hint, and raw JPEG bytes. `META` carries UTF-8 JSON for the existing
`Status` and `Tabs` event shapes. In the other direction, `INPUT` carries UTF-8 JSON containing the
active target id and the existing browser input event union. There is deliberately no frame ACK:
Chromium is ACKed immediately at CDP receipt, and the browser stream never waits for a remote client.

The web Browser panel uses the raw socket for frames, status, tabs, and manual input. The unary
`browser.*` RPCs still own lifecycle/tab/address-bar operations. `browser.subscribeViewport` and
`browser.dispatchInput` remain supported for compatibility and programmatic clients, but the web
hot path no longer calls either. Raw JPEGs stay outside Zustand and persistence, enter the existing
latest-frame renderer through `Blob`/`createImageBitmap`, and are dropped there again if decoding or
animation-frame rendering falls behind. A running view whose newest frame is over two seconds old
shows the existing paused overlay.

On the Node server, Effect's websocket abstraction does not expose the underlying WebSocket
`bufferedAmount`, and its writer completes after `ws.send` rather than after network drain. The
upgraded Node request does expose its underlying TCP socket's `writableLength`, so each connection
skips frames while that real unsent-byte count is at least 256 KiB. A connection-owned writer pump
also keeps only one newest pending frame while a write is in progress; low-frequency metadata keeps
order independently. Input is consumed by the socket reader and dispatched independently of that
writer pump. On a non-Node adapter where the request source has no `writableLength`, the latest-only
slot still prevents an application frame backlog, but the 256 KiB transport threshold is not
observable; phase 4 is verified and deployed on the repository's Node server path.

Set `SALCHI_BROWSER_STREAM_DEBUG=1` to log, at debug level only, the captured/mailbox-published frame
to socket-write delta, each input's receive-to-CDP-complete time, event-loop delay p50/p99 every five
seconds, any instrumented browser handler over 50 ms, page-CDP attach/detach counts, and backpressure
skips. Development builds also log receive-to-canvas-render and input-send-to-next-render timings in
the browser console. The gated localhost comparison uses
the same Chromium/page for both retained transports; the final verification run measured 28.7 ms
over the legacy JSON RPC stream and 10.0 ms over the binary socket. These localhost numbers mainly
show removed serialization/ACK overhead; the intended improvement is larger on a high-RTT phone-to-
VPS connection.

Manual verification:

1. Start Salchi on the VPS, open a thread and its Browser panel, then start the browser.
2. From a phone on cellular, tap a visible link and confirm the first tap enables interaction and
   the next frame feels immediate while the connection-quality overlay stays clear.
3. Disable networking or kill the browser-stream websocket mid-stream, restore connectivity, and
   confirm the ticket/reconnect loop resumes frames.
4. Hide the panel, switch right-panel views and switch threads; in every case confirm the raw socket
   closes and the final viewport subscriber stops the screencast.

## Latency investigation notes

Browser input bypasses both manager and Playwright per-thread operation semaphores. The manager
reads the already-running entry, and the runtime uses the active tab's cached `CDPSession`; a
successful event performs exactly one `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, or
`Input.insertText` command. The cache is invalidated before active-tab replacement/removal and set
to the new active tab before input resumes. Input socket reads run independently from the frame
outbox writer, so a slow frame write cannot hold an input message. Tab/title refreshes remain on the
serialized control path and navigation notifications are coalesced.

The Playwright MCP implementation pinned by Salchi retains its current tab and creates a page only
when no current tab exists or the agent explicitly requests a new one. A live inspection that showed
one top-level page but hundreds of targets identified ad-heavy out-of-process iframes, not a fresh
Playwright page per tool call; Chromium renderer client ids are monotonic and therefore are not a
live-page count. Salchi still detaches each per-page CDP session and removes all CDP/Page listeners
when that page closes, including configuration-failure cleanup. A page pool would conflict with
explicit MCP new-tab semantics and is therefore not added.

## Agent browsing picture-in-picture

The browser stream's version-1 `META` union also carries `{ "agentActive": boolean }`. A session
becomes agent-active on the first CDP command received from an authenticated agent proxy. Proxy
open/close, heartbeats, Chromium responses, viewport subscribers, and user input do not activate
the signal. The active window is four seconds after the latest command; its inactive transition is
held for another two seconds to avoid flapping during short command gaps. Stop and crash reset the
signal immediately. The manager owns the transition monitor and replay-one activity feed, so server
scope shutdown interrupts both the monitor and its subscriptions.

The web app uses a ref-counted connection pool keyed by environment and root thread. The hidden
activity listener, full Browser panel, and picture-in-picture canvas are logical consumers of that
pool, but they share exactly one ticketed raw websocket and therefore one server viewport
subscriber. Raw frames remain outside Zustand and persistence; both canvases use the existing
latest-only JPEG renderer. Because activity is delivered only on the browser stream, enabling the
automatic preview keeps that one stream connected for the current thread even while the card is
hidden. Consequently it also holds the current route's viewport-subscriber/idle lease. This is the
unavoidable lifecycle consequence of the phase's fixed protocol; disabling **Show browser preview
while agent browses** restores subscribe-only-while-panel-visible behavior.

On desktop, the view-only card is draggable and corner-resizable, and its pixel position/size are
stored in device-local storage. On mobile it is a fixed 16:10 card at roughly 40% viewport width;
dragging its header snaps it to the nearest corner. Clicking the image opens the full Browser panel,
while close suppresses the card until the next inactive-to-active transition for that thread. The
last frame lingers for three seconds after activity stops and then fades. Opening the panel,
switching threads, stopping, or crashing hides it immediately. Native video PiP remains out of
scope, but the preview is isolated behind the same canvas renderer so a future capture-stream
consumer does not require another browser socket.

Manual verification:

1. Leave the Browser panel closed and ask an agent to navigate; confirm the preview appears over
   the lower-right chat area and follows the live page.
2. Click the preview body; confirm the full Browser panel opens and the preview disappears without
   creating a second browser-stream connection.
3. Close the preview during an activity burst; confirm it stays hidden until activity ends and a
   later command burst begins.
4. Let the agent finish; confirm the final frame remains for three seconds and fades.
5. On desktop, drag and resize the card, then reload and confirm its layout persists. On mobile,
   drag it across the chat and confirm it snaps to the nearest corner.
