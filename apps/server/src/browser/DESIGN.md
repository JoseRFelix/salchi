# Browser use phase 1

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

Requests to the instance's own listening host and port and to `169.254.169.254` are failed through
CDP interception and logged. Explicit stop, thread deletion, idle timeout, and server-scope shutdown
close Playwright gracefully and then ensure the Chromium process tree is gone. Unexpected process
exit is observable as `crashed` and is restarted only by an explicit start.

Phase 2 adds provider-neutral CDP environment/tool injection, the right-panel viewport UI, and
tap-to-interact input translation.
