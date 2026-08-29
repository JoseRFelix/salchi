# Browser binary-stream benchmark

These are **post-fix** measurements for the version-1 binary browser transport, recorded on
2026-08-28. They are not phone/VPS field measurements. Each row is the median of five real-Chromium
runs in a fresh unprivileged user/network namespace. Linux `tc netem` shaped namespace loopback with
half the stated RTT in each direction and 1% packet loss:

```sh
unshare --user --map-root-user --net bash -lc '
  ip link set lo up
  tc qdisc add dev lo root netem delay <RTT/2>ms loss 1%
  SALCHI_BROWSER_INTEGRATION=1 \
  SALCHI_BROWSER_STREAM_DEBUG=1 \
  SALCHI_BROWSER_BENCHMARK_RTT_MS=<RTT> \
  SALCHI_BROWSER_NO_SANDBOX=1 \
  SALCHI_BROWSER_PATH=<chromium> \
  vp run --filter salchi test src/server.test.ts \
    -t "runs the gated browser stream click integration"
'
```

`SALCHI_BROWSER_NO_SANDBOX=1` is used only because Chromium runs inside the nested user/network
namespace. Normal Salchi browser launches retain their configured sandbox policy.

| Simulated RTT / loss | Click → second CDP dispatch | Receive → CDP (down / up) | CDP frame → mailbox | Mailbox → socket write | CDP frame → socket write | Click → fresh frame received |
| -------------------- | --------------------------: | ------------------------: | ------------------: | ---------------------: | -----------------------: | ---------------------------: |
| 0 ms / 1%            |                     6.11 ms |            3.75 / 2.83 ms |             0.42 ms |                0.82 ms |                  1.23 ms |                      10.4 ms |
| 80 ms / 1%           |                    45.86 ms |            3.27 / 2.33 ms |             0.48 ms |                0.73 ms |                  1.25 ms |                      95.0 ms |
| 200 ms / 1%          |                   105.76 ms |            3.27 / 2.17 ms |             0.51 ms |                0.74 ms |                  1.19 ms |                     215.2 ms |

“Click” is the client sending a `PointerDown` and `PointerUp`. “Second CDP dispatch” is the server
observer seeing the second `browser.input.socket-receive-to-cdp-complete` sample. “Fresh frame” is
the first binary frame received after both dispatches completed. Frame-stage values come from the
existing `SALCHI_BROWSER_STREAM_DEBUG=1` instrumentation, exposed to the gated benchmark through a
temporary observer that is removed by the test scope.

These figures stop at raw frame receipt; browser JPEG decode, `requestAnimationFrame`, display
refresh, and the real carrier/VPS path add client-visible latency. The five-run localhost legacy RPC
median was 30.0 ms versus 10.4 ms for binary. Under simulated 80 ms RTT it was 179.3 ms versus
95.0 ms, and under simulated 200 ms RTT it was 423.1 ms versus 215.2 ms. The internal
CDP-receive-to-socket-write median remained approximately 1.2 ms at every RTT, which is consistent
with network transit—not server queue or event-loop growth—dominating the shaped runs.
