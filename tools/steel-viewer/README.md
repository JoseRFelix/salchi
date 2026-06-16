# Steel viewer touch-scroll patch

The Steel session viewer (`live-session-streamer.ejs`) only forwards scrolling from
the DOM `wheel` event, so a finger swipe on a phone never scrolls the remote page —
it registers `mousedown`/`mouseup`/`mousemove`/`wheel`/keyboard listeners but no
`touch*` handlers. This patch adds single-finger touch → `mouseWheel` translation
(reusing Steel's existing server-side `mouseWheel` path) plus `touch-action: none` on
the canvas so the browser doesn't claim the gesture.

## Files

- `live-session-streamer.ejs` — the patched template (full copy).
- `touch-scroll.patch` — unified diff against `ghcr.io/steel-dev/steel-browser:latest`
  (the image `salchi-steel-browser` runs).

## Why this is needed as an overlay

Steel runs from the stock upstream image with no bind mounts, so any edit made
directly inside the container's writable layer survives `docker restart`/reboot but is
**lost on `docker rm` / image re-pull / recreate**.

## Applying it durably (bind mount — recommended)

Add this volume to however `salchi-steel-browser` is launched (the `docker run`
command / wrapper script):

```
-v /home/ubuntu/t3code/tools/steel-viewer/live-session-streamer.ejs:/app/api/build/templates/live-session-streamer.ejs:ro
```

Then recreate the container. `NODE_ENV=production` makes Fastify's view engine cache
the compiled template, so the container must be (re)started for changes to take effect.

## Re-applying after an image update

If you pull a newer Steel image, re-generate the patch against the new template:

```
docker run --rm --entrypoint cat ghcr.io/steel-dev/steel-browser:latest \
  /app/api/build/templates/live-session-streamer.ejs > pristine.ejs
# re-apply touch-scroll.patch (or the three edits) onto pristine.ejs
```

## Upstreaming

The cleaner long-term fix is a PR to https://github.com/steel-dev/steel-browser adding
touch handling to `setupCanvasEventListeners` in
`api/src/templates/live-session-streamer.ejs`. The same diff applies to the `src` copy.

## Current state

The running `salchi-steel-browser` container already has this patch applied (copied into
both `build/templates` and `src/templates` and restarted). It is verified live in the
served viewer HTML, but is **not durable** until the bind mount above is added.
