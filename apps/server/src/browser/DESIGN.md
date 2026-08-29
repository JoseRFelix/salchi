# Browser use architecture

Salchi owns one headless Chromium process for each **root orchestration thread**. The process is
provider-neutral: the user controls it through the Browser panel, while coding agents attach to the
same process through a protected CDP proxy. A browser can contain multiple tabs and uses a persistent
profile at `~/.salchi/userdata/browser-profiles/<rootThreadId>/`, so cookies and logins survive browser
and server restarts. Live processes, tabs, and CDP URLs are not reconstructed after a server restart.

```text
  web app / CLI                          server process
  +----------------------+               +----------------------------------------------+
  | Browser panel + PiP  |---- RPC/WS -->| BrowserSessionManager                        |
  | guided install card  |---- RPC ----->| BrowserInstaller -- scoped worker --------+  |
  | salchi browser install|--- direct --->|                                      |       |
  +----------------------+               |                                      v       |
                                         |                    managed variant resolver  |
  provider process                       |              (SALCHI_HOME shell / OS Chrome) |
  +----------------------+               |                                      |       |
  | salchi-browser MCP   |-- loopback -->| BrowserAgentBroker                    |       |
  | custom CDP clients   |   token WS    |             |                        |       |
  +----------------------+               |             v                        v       |
                                         |        Chromium + persistent context          |
                                         |             +-- per-tab CDP sessions           |
                                         +----------------------------------------------+
```

The browser manager and agent broker are runtime-layer services. They are independent of
`ProviderSessionReaper`; browser lifetime follows the rules below, while each agent credential is
released with its provider session.

## Ownership and root-thread normalization

Browser state is keyed by the first orchestration thread without a `parentThreadId`.
`parentThreadId` is the ownership edge for materialized provider children;
`createdByThreadId` is provenance for a genuine independent thread and is deliberately not followed.
Consequently, an independent thread owns its own browser process, profile, idle lifecycle, and agent
credential even when another thread created it. A materialized child beneath that independent thread
resolves to the independent thread, not to its creator's parent. Resolution detects parent cycles and
fails when a required thread is missing. Every manager operation normalizes its requested id before
accessing the session map, including unary RPC operations, viewport/activity subscriptions, input
dispatch, and agent-connection accounting.

The public stream route passes its requested id through the same manager boundary. Agent access is
normalized before the credential and stable proxy URL are created, so every provider seam receives
its browser-root id in `SALCHI_BROWSER_CDP_URL`; for an independent provider session, that is the
independent thread's own id. The credential separately retains the provider session's originating
thread id for activity scoping. The live `threadExists` predicate accepts every real orchestration
root, including independent threads, and rejects materialized children. On startup Salchi warns—but
never automatically prunes—profile directories that do not correspond to a current root thread.
`salchi browser prune-profiles` lists those directories and deletes them only when passed
`--confirm`. Deleting any root thread stops its browser and removes that thread's profile; deleting a
materialized child cannot remove its root owner's profile. Profiles formerly shared because of the
old `createdByThreadId` traversal are not copied into the newly independent profile.

## Browser runtime

### Executable acquisition, guided installation, and process isolation

Browser start resolution order is:

1. `SALCHI_BROWSER_PATH`;
2. the `browserExecutablePath` server setting;
3. Playwright's installed system Chrome/Chromium/Edge channels; and
4. Salchi's managed executable under `$SALCHI_HOME/browsers`.

When no earlier candidate works and the managed browser is absent, `BrowserUnavailable` carries
`reason: "not-installed"`. The owner UI offers a one-click install, streams progress through
`browser.install`, and starts the thread session automatically on completion. The equivalent
headless flow is `salchi browser install [--yes]`. `browser.getInstallState` replays one of
`not-installed`, `installing`, `installed`, `needs-elevation`, or `failed`, tagged with the selected
variant; concurrent streams for that variant join the same in-flight fiber. `browser.cancelInstall`
is the only caller action that interrupts that shared installation. Disconnecting one progress
consumer does not cancel it, while server-scope shutdown does.

`browserManagedVariant` records which managed candidate is preferred when both are present. It does
not alter the fixed environment → setting → system-channel → managed resolution order.

| Variant                    | Approx. disk use | Fingerprinting / compatibility                                       | Installation location and elevation                                                                                                   |
| -------------------------- | ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `headless-shell` (default) | ~180 MB          | Lightweight and the most detectable                                  | Hermetic under `$SALCHI_HOME/browsers`; no elevation                                                                                  |
| `chrome`                   | ~350 MB          | Branded binary; better compatibility with automation-sensitive sites | Playwright's normal OS application location; Linux x64 requires an administrator command, and Playwright does not support Linux Arm64 |

The headless-shell Playwright revision was verified with a persistent context, loopback external
CDP, multiple clients, and `Page.startScreencast`; those are the runtime capabilities Salchi needs.
Playwright fixes `PLAYWRIGHT_BROWSERS_PATH` when its registry module loads, so Salchi runs the
registry installer in a scoped child worker with that variable set before `coreBundle` is required.
For the hermetic variant, `TMPDIR`, `TMP`, and `TEMP` also point below
`$SALCHI_HOME/browsers/tmp`; the download, extraction, manifest, and lock files therefore never
leave `SALCHI_HOME`. The worker and downloader process tree are registered and terminated on cancel
or scope shutdown. The install directory is mode `0700` and its manifest is mode `0600`.

Salchi never invokes `sudo`. On supported Linux x64 distributions Playwright's `chrome` target is an
OS package install, so the installer detects that before spawning a worker and publishes a distinct
`needs-elevation` state with an exact Playwright CLI or distro package command. The UI renders it as
instructions and re-probes the system Chrome channel when the owner chooses **Check again**. On
macOS and Windows the Playwright channel installer runs normally. If Playwright/Chromium reports a
missing shared-library signature, the typed `BrowserUnavailable` instead carries
`reason: "missing-libraries"` and one copy-paste dependency command. Playwright's exact apt package
command is preserved on Debian-family hosts; RPM-family loader errors are expressed as a `dnf`
provider lookup for the missing `.so` files. The UI displays that command prominently.

Failure reports every attempted path/channel as a typed `BrowserUnavailable` error. Chromium starts
with an 800×600 viewport and device scale factor 1. With `browserViewportFollowsPanel` enabled, each
visible full Browser panel registers its content size under that RPC WebSocket's scoped owner id.
The server selects the request with the largest area; the latest writer wins an equal-area tie.
Requests are clamped to 320–1280 pixels wide and 480–1024 pixels high, then snapped to even values.
Closing or switching the panel sends an explicit release, and the WebSocket scope finalizer releases
all requests from an abruptly disconnected owner. The PiP never registers a size request.

While `agentActive` is true, the policy retains only the latest winning size without changing CDP
metrics. The pending size applies on the active-to-inactive transition. Disabling panel following
uses 800×600 regardless of retained panel requests; re-enabling selects the current winner. Runtime
changes use `Emulation.setDeviceMetricsOverride` on every configured page with device scale factor 1
and restart only the active page's screencast within the existing serialized operation ordering.
Chromium's sandbox remains enabled unless `SALCHI_BROWSER_NO_SANDBOX=1`; that opt-out emits a
prominent warning. The process always receives `--disable-dev-shm-usage`, a dynamically allocated
remote-debugging port, and `--remote-debugging-address=127.0.0.1`.

The session scope owns the persistent Playwright context, page CDP sessions, idle monitor, and
launch fiber. Its finalizer first attempts a bounded graceful Playwright close, then terminates the
Chromium process group/tree. On Linux the process is also registered with
`ManagedChildProcessRegistry`, following the provider process-group precedent, so server cleanup can
reap descendants that escape the graceful path.

Optional `browserStealthMode` removes Playwright's `--enable-automation` default argument, installs
a `Page.addScriptToEvaluateOnNewDocument` override that suppresses `navigator.webdriver`, and uses
the launched browser's own current user agent after replacing its `HeadlessChrome` product marker
with `Chrome`. This is best-effort fingerprint reduction only: it does not make automation
undetectable or guarantee that a captcha provider will accept a session. When the selected managed
variant is branded Chrome, stealth launches that binary with explicit new-headless mode. The
recommended best-effort combination for difficult sites is `chrome` plus stealth mode;
headless-shell remains the lightweight and most detectable default.

### Tabs, interception, and input

Each page has one cached CDP session. Page listeners publish coalesced tab/title/navigation updates;
closing a page removes those listeners and detaches its CDP session. Pages created by an external
CDP client are observed through the persistent context's `page` event and enter the same setup path,
so they appear in the tab bar and receive the navigation guard.

The guard statically blocks these destinations:

- `169.254.169.254`, `metadata.google.internal`, and `fd00:ec2::254`, regardless of port;
- Salchi's own listening host and port; and
- loopback aliases at Salchi's listening port.

The targeted `Fetch.enable` guard is installed once on Chromium's browser CDP target, so it covers
requests initiated by pages and service workers. It receives only candidate URL patterns for the
blocked hosts and never pauses every request. Each matching request is failed and logged at info
level. There is deliberately no DNS resolution: a different hostname that resolves to a blocked IP
is not blocked unless that hostname itself appears in the static list.

The web stream and compatibility RPC both call the same `dispatchInput` path. It resolves the root
and reads the current running entry without taking the per-thread manager semaphore. The runtime
uses the active tab's cached CDP session without its control-operation semaphore, rejects a stale or
inactive target, applies a rolling 200-events-per-second session limit, clamps coordinates to the
latest frame dimensions, and performs exactly one of:

- `Input.dispatchMouseEvent` for pointer and wheel input;
- `Input.dispatchKeyEvent` for key input; or
- `Input.insertText` for composed text.

Successful input records ordinary CDP activity. The active input session is invalidated before an
active tab is changed or removed. Input never refreshes tab metadata or waits behind frame output.

## Viewport data path

While at least one viewport subscriber exists, the active tab runs `Page.startScreencast` with JPEG
quality 45 by default, maximum width and height equal to the current viewport, and device scale
factor 1. The idle cadence emits every second compositor frame by default. A new screencast is primed
at every frame until its first JPEG arrives, preventing an already-painted static page from being
skipped, and then returns to its configured cadence. Input temporarily boosts the active screencast
to every frame; two seconds after the most recent input, it returns to the configured cadence. CDP
stop/start for a cadence or viewport change is serialized with existing page operations while the
mailbox, transport, and last frame remain live. The runtime acknowledges each
`Page.screencastFrame` immediately, then publishes it to a capacity-one mailbox. Publishing replaces
the previous value: the newest frame wins and no frame queue exists in the browser manager.

```text
Page.screencastFrame (base64 from CDP)
  -> immediate Page.screencastFrameAck
  -> decode once to JPEG bytes
  -> latest-value binary mailbox (replace stale frame)
  -> per-connection outbox (one writing + one newest pending)
  -> raw JPEG browser-stream FRAME
  -> Blob/createImageBitmap
  -> one newest pending requestAnimationFrame paint
```

The first subscriber starts the screencast. The last release stops it but leaves Chromium running.
Frames never enter Zustand, client persistence, orchestration events, or SQLite. The original
`browser.subscribeViewport` Effect RPC stream remains a compatibility API and re-encodes base64
JPEG only at that legacy edge; the binary mailbox-to-socket hot path never re-encodes or decodes.
The web application uses the raw browser stream for frames and metadata.

## Public browser stream

The public listener exposes:

```text
ws(s)://<salchi-host>/browser-stream/<threadId>?ticket=<short-lived-websocket-ticket>
```

It authenticates the ticket with the same websocket-upgrade mechanism as `/ws` and requires the
owner-only `browser:operate` scope **before** calling `request.upgrade`. A missing/invalid ticket is
rejected by authentication and a valid non-owner session is rejected with HTTP 403. Unlike the agent
proxy, this route is intentionally available through the same external/Tailscale Serve listener as
`/ws`, because browsers and phones use it.

Each connection acquires one normal manager viewport subscription and releases it when its Effect
connection scope completes, including abrupt socket loss. Multiple clients are supported. The web
side adds a ref-counted pool keyed by environment and thread: the Browser panel and PiP are logical
consumers of one physical ticketed socket, and thus one server subscriber. The hidden PiP trigger
uses the activity-only RPC stream and owns no viewport subscription. The retained viewport RPC stream
independently counts as a subscriber when a programmatic client uses it.

### Version 1 wire protocol

Every binary websocket message starts with a one-byte version (`0x01`) and one-byte type.
Multi-byte integer fields use network byte order.

| Direction       | Type             | Body                                                                         |
| --------------- | ---------------- | ---------------------------------------------------------------------------- |
| server → client | `FRAME` (`0x01`) | `u32 seq`, `u16 width`, `u16 height`, `u8 tabIndexHint`, raw JPEG bytes      |
| server → client | `META` (`0x02`)  | UTF-8 JSON: viewport `Status`, viewport `Tabs`, or `{threadId, agentActive}` |
| client → server | `INPUT` (`0x03`) | UTF-8 JSON: `{targetId, event}` using the browser input tagged union         |

There is no application-level frame ACK. CDP frames are acknowledged on receipt, and input is read
and dispatched by a fiber independent of the frame writer. Effect's socket writer does not expose a
browser-style `bufferedAmount`; on Node the route reads the upgraded TCP socket's `writableLength`
and skips a frame at or above the 256 KiB default threshold. Its outbox permits one write plus one
replaceable pending frame. Metadata has one replaceable latest slot per kind (status, tabs, and
activity), so a stalled consumer never accumulates a history. On adapters without `writableLength`,
the replaceable pending frame remains the application-level backlog bound.

The client exchanges a fresh ticket and reconnects with exponential backoff, reconnecting promptly
when document visibility returns. It does not retry authorization failures. Frames decode with
`Blob`/`createImageBitmap` when available and paint on `requestAnimationFrame`; both decode and paint
stages retain only the newest pending frame. Aspect-fit rendering preserves the image, accounts for
device pixel ratio, and letterboxes within the panel.

## Browser panel and PiP

The Browser view is part of the existing resizable right-panel registry and responsive sheet. Its
address bar provides back, forward, reload, and navigation; its tab strip supports selection, open,
and close. Stopped, starting, running, crashed, and authorization states are order-tolerant. The
visible full panel reports its canvas content size immediately on open and after a 500 ms settled
resize; a portrait mobile panel therefore produces a portrait page viewport. Multiple owner
surfaces are reconciled by the server rather than by clients. Input mapping continues to invert the
frame's self-described aspect-fit/letterbox transform, and the server clamps against the active
page's latest frame dimensions rather than an 800×600 constant. The
first valid viewport click/tap enables interaction and forwards that same gesture—there is no header
toggle. Hiding the panel, changing view/thread, closing the sheet, stopping/crashing, or losing
authorization disables it. A quick touch taps, a moving single finger scrolls, and a 450 ms hold
before movement begins click-drag. Desktop keyboard input targets the focused canvas; mobile uses a
hidden input for text, Enter, and Backspace.

The stream's agent-activity metadata drives a view-only PiP. An authenticated proxy's first CDP
command publishes `{threadId: <originating provider thread>, agentActive: true}` immediately.
Further commands from that origin extend a four-second active window; the transition to false waits
another two seconds to avoid flapping. If traffic switches origins within a deliberately shared
session, a new active event identifies the new origin. The client treats a nonmatching origin as
inactive, so activity can never surface a PiP on another independent thread. Proxy open/close,
heartbeat, Chromium responses, viewport traffic, and user input affect idle activity but do not mark
the agent active. Stop and crash reset the signal immediately with the last origin id.

With the client setting **Show browser preview while agent browses** enabled, activity starts a PiP
when the full panel is closed. It lingers for three seconds after inactivity, suppresses itself for
the remainder of an activity burst after manual close, and hides immediately for panel open,
thread change, stop, or crash. Desktop position/size and mobile snapped corner are device-local. PiP
is never interactive; clicking it opens the full panel.

## Agent CDP proxy and automatic MCP

Each provider session receives a random 256-bit credential and, when
`browserAgentAccessEnabled` is true, this stable capability URL:

```text
SALCHI_BROWSER_CDP_URL=ws://127.0.0.1:<brokerPort>/internal/browser/cdp/<rootThreadId>/<token>
```

The broker is a dedicated kernel-assigned listener bound only to `127.0.0.1`; it is not mounted on
the public listener or Tailscale Serve. An explicit public deny route returns 404 for
`/internal/browser/cdp/*`. Upgrades reject non-loopback peers, any forwarding headers, query strings,
malformed paths, inactive/unknown tokens, and a token used with a different thread. Ordinary HTTP
requests receive 404. The credential is revoked with the provider session and the capability URL is
never logged at info level.

After validation the broker lazily starts or reuses the root browser, resolves its private Chromium
browser websocket, and pipes CDP messages bidirectionally. Chromium supports multiple independent
browser-endpoint clients. Closing one side closes only that proxy pipe, not Chromium. A live proxy
connection holds the idle controller through connection accounting and a 30-second heartbeat;
traffic also updates CDP activity. Stop/crash closes Chromium and therefore attached pipes, while a
new connection through an otherwise valid stable URL lazily launches a new process.

### Security model

The accepted threat model is a **single-user host**. The token is a bearer capability, not an
operating-system user credential. Another OS user on the same machine who can read provider/MCP
process environments, or who steals the token and can connect to loopback, can control that thread's
browser until the provider credential is released. Hosts with mutually untrusted local users need an
additional OS isolation boundary.

Credentials live only in the broker's in-memory map and provider process environment. Salchi does
not persist tokens or proxy URLs anywhere under `~/.salchi`, so there is no token-bearing file whose
mode needs hardening to `0600`. Capability-shaped values are redacted from background failure logs,
and HTTP/WebSocket rejection reasons are generic. `browser.getState` exposes Chromium's direct CDP
URL only after the owner-only `browser:operate` check; a non-owner receives no state payload.

Salchi pins `@playwright/mcp` 0.0.74 and resolves its installed `cli.js` once, avoiding an
`npx` network fetch during provider startup. Resolution is best-effort: failure warns, omits only the
browser MCP/instruction, and starts the provider normally. Registration uses the name
`salchi-browser` and tells the agent to use it instead of launching a separate browser:

- Claude: SDK query options beside the in-process `salchi` MCP server;
- Codex: request-scoped `mcp_servers.salchi-browser` config for start and resume, without modifying
  `CODEX_HOME`;
- Cursor/Grok: ACP `mcpServers` for new and loaded sessions, beside `SalchiAcpMcpServer`;
- local OpenCode: per-process `OPENCODE_CONFIG_CONTENT`; externally hosted OpenCode is unsupported
  because Salchi does not own its process configuration. When agent access is enabled, a remote
  OpenCode session logs this limitation at debug level and the Browser panel shows a one-line
  notice instead of silently implying that the remote agent received browser tools.

Registration, the behavioral instruction, and proxy environment injection are all setting-gated
and repeat on recovery/resume paths. Custom provider setups may use the injected URL directly. The
equivalent manual commands (Salchi does not run these) are:

```sh
npx -y @playwright/mcp@0.0.74 --cdp-endpoint "$SALCHI_BROWSER_CDP_URL"
npx -y chrome-devtools-mcp@1.8.0 --wsEndpoint "$SALCHI_BROWSER_CDP_URL"
```

## Lifecycle

A browser does not start with a provider session. `browser.start`, an agent proxy connection, or a
compatible explicit caller starts it lazily. It remains alive with zero viewport subscribers. Idle
shutdown occurs only when there are no subscribers, no attached proxy connections, and no CDP
activity for the configured timeout (15 minutes by default).

| Trigger         | Browser session                                                                                           | Agent proxy                                                                                | Public/RPC viewport consumer                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `browser.stop`  | publishes `stopped`, closes session scope, gracefully closes Playwright, then enforces process-tree death | Chromium side closes each pipe; stable credential remains reconnectable                    | subscription remains and observes stopped metadata; screencast is gone                    |
| thread deletion | stops the browser, then removes that thread's persistent profile; later starts fail root existence        | attached pipes close; a retained token cannot restart a deleted thread                     | UI/thread teardown closes the client; server subscription releases on socket/stream close |
| idle timeout    | same finalizers as stop; impossible while a subscriber or agent connection is present                     | therefore no attached proxy at the instant idle wins                                       | therefore no open viewport subscriber at the instant idle wins                            |
| Chromium crash  | publishes `crashed`, resets agent activity, closes the failed session scope; no automatic restart         | Chromium side drops; reconnect through a valid credential explicitly/lazily restarts       | connection stays subscribed to manager metadata and can observe crash/restart             |
| server shutdown | manager scope closes all session scopes/fibers; runtime/process-registry finalizers reap Chromium         | broker scope terminates pending/active pipes, revokes credentials, closes WS/HTTP listener | public HTTP/WS scope interrupts routes; RPC/raw subscription scopes release               |

An in-progress managed-browser installation is owned by the server layer rather than a thread. On
server shutdown its fiber is interrupted and its worker/downloader tree is terminated. A later
install request validates the managed manifest and safely resumes/retries through Playwright's own
registry lock. Browser stop, thread deletion, crash, and idle timeout do not remove the shared
managed installation. `prune-profiles` only touches per-thread profile directories.

The manager transfers already-held subscriber and agent-connection counts into a newly launched
session, so an explicit restart restores screencasting when appropriate. Unexpected exit is never
restarted in the background.

## Settings and diagnostics

| Name                                    | Default          | Purpose                                                          |
| --------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| server `browserExecutablePath`          | empty            | explicit executable after `SALCHI_BROWSER_PATH`                  |
| server `browserIdleTimeout`             | 15 minutes       | inactivity deadline after the final subscriber/agent connection  |
| server `browserAgentAccessEnabled`      | `true`           | proxy credentials, MCP registration, and browser-use instruction |
| server `browserKillRogueBrowsers`       | `false`          | terminate provider-descended external Chromium trees             |
| server `browserManagedVariant`          | `headless-shell` | selected managed install/resolution candidate                    |
| server `browserScreencastQuality`       | `45`             | CDP JPEG screencast quality, from 0 through 100                  |
| server `browserScreencastEveryNthFrame` | `2`              | idle compositor-frame sampling cadence, from 1 through 60        |
| server `browserViewportFollowsPanel`    | `true`           | largest visible full panel controls the clamped viewport         |
| server `browserStealthMode`             | `false`          | best-effort automation fingerprint reduction                     |
| client `showBrowserAgentPreview`        | `true`           | automatic activity listener and PiP                              |
| `SALCHI_BROWSER_PATH`                   | unset            | highest-priority Chromium executable                             |
| `SALCHI_BROWSER_NO_SANDBOX`             | unset            | `1` is the explicit sandbox opt-out                              |
| `SALCHI_BROWSER_STREAM_DEBUG`           | unset            | `1` enables browser hot-path debug instrumentation               |

Debug mode reports event-loop lag p50/p99 every five seconds, input receive-to-CDP completion,
CDP-frame receive/mailbox/socket-write timing, page CDP attach/detach counts, backpressure skips, and
instrumented handlers over 50 ms. Development clients log frame receive-to-render and
input-send-to-next-render gaps. The five-run post-fix benchmark measured median binary
click-to-fresh-frame times of 10.4 ms at 0 ms RTT, 95.0 ms at 80 ms RTT, and 215.2 ms at 200 ms RTT
with 1% loss. The corresponding internal CDP-frame-to-socket-write medians stayed near 1.2 ms.
Methodology, stage timings, and the legacy comparison are recorded in [BENCHMARK.md](BENCHMARK.md).

## Known limitations

- JPEG screencast compression, transfer, decode, and canvas paint impose a latency/quality ceiling;
  there is no adaptive codec or WebRTC transport.
- The navigation guard uses static hostname matching only. A DNS alias that resolves to a blocked
  IP bypasses the guard unless the alias itself is listed; the guard does not attempt a comprehensive
  private-network SSRF policy.
- Stealth mode changes only a small set of automation fingerprints. Browser behavior, timing,
  graphics, installed fonts, IP reputation, and many other detectable signals remain unchanged.
- Native video PiP (`captureStream`/`requestPictureInPicture`) is not implemented; the current PiP is
  an in-app canvas card.
- The activity-only RPC remains subscribed while automatic PiP is enabled, but it owns no viewport
  or idle lease. A named raw-stream lease exists only for a visible panel or PiP (including linger)
  and transfers in place between those surfaces.
- The loopback CDP token is a bearer secret rather than an OS-user-bound credential, as described in
  the proxy security model above.
- Automatic MCP registration is unavailable for remotely managed OpenCode servers; this is shown
  in the Browser panel and logged at remote session start when browser agent access is enabled.
- The managed browser download cannot install kernel features or OS shared libraries. Salchi can
  classify that failure and show the dependency command, but the administrator must run it.
- Switching managed variants does not remove the unselected artifact; cleanup is manual. Branded
  Chrome is an OS-level Playwright channel install rather than a hermetic Salchi download on
  platforms where that channel installer is available.
