import type { AdvertisedEndpoint, TerminalSessionSnapshot } from "@t3tools/contracts";
import type { TerminalEventEntry } from "./terminalStateStore";
import { extractTerminalLinks } from "./terminal-links";

export interface DevServerLink {
  readonly url: string;
  readonly displayUrl: string;
  readonly label: string;
  readonly host: string;
  readonly port: string;
}

export interface DevServerProbeOptions {
  readonly browserHostname?: string;
  /**
   * Liveness check for `url`, typically the environment's
   * `server.probeDevServerUrl` RPC. Runs only after the browser-route gate
   * (`canCurrentBrowserReachDevServerUrl`) passes.
   */
  readonly probe: (url: string) => Promise<boolean>;
}

export interface DevServerTailscaleRewriteOptions {
  readonly advertisedEndpoints?: ReadonlyArray<Pick<AdvertisedEndpoint, "httpBaseUrl" | "id">>;
  readonly browserHostname?: string | null;
  readonly environmentHttpBaseUrl?: string | null;
  readonly serverAvailableViaTailscale?: boolean;
}

interface DevServerCandidate {
  readonly url: string;
  readonly context: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly sequence: number;
}

interface TailscaleDevServerHostAlias {
  readonly hostname: string;
  readonly kind: "tailscale-ip" | "magicdns";
}

const DEV_SERVER_CONTEXT_PATTERN =
  /\b(?:astro|available|development|expo|local|listening|metro|network|next(?:\.js)?|nuxt|parcel|ready|remix|rspack|rsbuild|running|serv(?:er|ing)|started|svelte(?:kit)?|turbopack|vite|webpack)\b/i;
const URL_TOKEN_PATTERN = /https?:\/\/[^\s"'`<>]+/gi;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const NON_TEXT_CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
function normalizeTerminalTextForLinkDetection(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(NON_TEXT_CONTROL_PATTERN, "")
    .replace(/\r/g, "\n");
}

function isIpv4Host(hostname: string): boolean {
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

function isPrivateOrLoopbackIpv4(hostname: string): boolean {
  if (!isIpv4Host(hostname)) return false;
  const [first = 0, second = 0] = hostname.split(".").map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

function isTailscaleCgnatIpv4(hostname: string): boolean {
  if (!isIpv4Host(hostname)) return false;
  const [first = 0, second = 0] = hostname.split(".").map(Number);
  // Tailscale assigns addresses from the CGNAT range 100.64.0.0/10.
  return first === 100 && second >= 64 && second <= 127;
}

function isTailscaleMagicDnsHost(hostname: string): boolean {
  return normalizeHostname(hostname).endsWith(".ts.net");
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/**
 * Whether the browser is itself on the tailnet — either loaded from a raw
 * Tailscale CGNAT IP or a MagicDNS (`*.ts.net`) name. Such a browser can route
 * to other tailnet (`100.x`) addresses even though the MagicDNS host it loaded
 * the app from never textually matches the dev server's raw `100.x` IP.
 */
function isTailnetBrowserHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return isTailscaleCgnatIpv4(host) || isTailscaleMagicDnsHost(host);
}

function isLocalDevHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "host.docker.internal" ||
    host.endsWith(".local") ||
    isPrivateOrLoopbackIpv4(host)
  );
}

function isLoopbackDevHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "host.docker.internal" ||
    host.startsWith("127.")
  );
}

function isBrowserLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.")
  );
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function tailscaleAliasFromHostname(hostname: string): TailscaleDevServerHostAlias | null {
  const normalized = normalizeHostname(hostname);
  if (isTailscaleCgnatIpv4(normalized)) {
    return { hostname: normalized, kind: "tailscale-ip" };
  }
  if (isTailscaleMagicDnsHost(normalized)) {
    return { hostname: normalized, kind: "magicdns" };
  }
  return null;
}

function tailscaleAliasFromUrl(value: string): TailscaleDevServerHostAlias | null {
  const url = parseHttpUrl(value);
  return url ? tailscaleAliasFromHostname(url.hostname) : null;
}

function normalizeDevServerUrl(value: string): string | null {
  const url = parseHttpUrl(value);
  if (!url) return null;
  url.hash = "";
  return url.href;
}

function displayUrlFor(value: string): string {
  const url = parseHttpUrl(value);
  if (!url) return value;
  if (url.pathname === "/" && url.search.length === 0 && url.hash.length === 0) {
    return url.href.slice(0, -1);
  }
  return url.href;
}

function isSparseUrlContext(context: string): boolean {
  return context.replace(/[^\w]+/g, "").length === 0;
}

function isDevServerCandidate(url: URL, context: string): boolean {
  if (url.port.length === 0 || !isLocalDevHost(url.hostname)) {
    return false;
  }
  return DEV_SERVER_CONTEXT_PATTERN.test(context) || isSparseUrlContext(context);
}

function contextWithoutUrls(line: string): string {
  return line.replace(URL_TOKEN_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function sourceLabelFor(context: string, hostname: string): string {
  if (/\bnetwork\b/i.test(context)) return "Network";
  if (/\blocal\b/i.test(context) || isLoopbackDevHost(hostname)) return "Local";
  return "Dev server";
}

function linkFromCandidate(candidate: DevServerCandidate): DevServerLink {
  const sourceLabel = sourceLabelFor(candidate.context, candidate.hostname);
  const displayUrl = displayUrlFor(candidate.url);
  return {
    url: candidate.url,
    displayUrl,
    label: `${sourceLabel} ${candidate.host}`,
    host: candidate.host,
    port: candidate.port,
  };
}

function tailscaleAliasLabel(alias: TailscaleDevServerHostAlias): string {
  return alias.kind === "tailscale-ip" ? "Tailscale IP" : "MagicDNS";
}

function tailscaleAliasPriority(alias: TailscaleDevServerHostAlias): number {
  return alias.kind === "tailscale-ip" ? 0 : 1;
}

function resolveTailscaleDevServerHostAliases(
  options: DevServerTailscaleRewriteOptions,
): TailscaleDevServerHostAlias[] {
  const aliasesByHostname = new Map<string, TailscaleDevServerHostAlias>();
  const addAlias = (alias: TailscaleDevServerHostAlias | null) => {
    if (!alias) return;
    aliasesByHostname.set(alias.hostname, alias);
  };

  addAlias(
    options.environmentHttpBaseUrl ? tailscaleAliasFromUrl(options.environmentHttpBaseUrl) : null,
  );
  addAlias(options.browserHostname ? tailscaleAliasFromHostname(options.browserHostname) : null);

  const isTailscaleContext =
    options.serverAvailableViaTailscale === true || aliasesByHostname.size > 0;
  if (!isTailscaleContext) {
    return [];
  }

  for (const endpoint of options.advertisedEndpoints ?? []) {
    if (!endpoint.id.startsWith("tailscale-")) continue;
    addAlias(tailscaleAliasFromUrl(endpoint.httpBaseUrl));
  }

  return [...aliasesByHostname.values()].toSorted(
    (left, right) =>
      tailscaleAliasPriority(left) - tailscaleAliasPriority(right) ||
      left.hostname.localeCompare(right.hostname),
  );
}

function rewriteDevServerLinkHost(
  link: DevServerLink,
  alias: TailscaleDevServerHostAlias,
): DevServerLink | null {
  const url = parseHttpUrl(link.url);
  if (!url) return null;
  url.hostname = alias.hostname;

  const displayUrl = displayUrlFor(url.href);
  return {
    url: url.href,
    displayUrl,
    label: `${tailscaleAliasLabel(alias)} ${url.host}`,
    host: url.host,
    port: url.port,
  };
}

export function rewriteDevServerLinksForTailscale(
  links: ReadonlyArray<DevServerLink>,
  options: DevServerTailscaleRewriteOptions,
): DevServerLink[] {
  const aliases = resolveTailscaleDevServerHostAliases(options);
  if (aliases.length === 0) {
    return mergeDevServerLinks(links);
  }

  const rewrittenLinks = links.flatMap((link) => {
    const url = parseHttpUrl(link.url);
    if (!url || !isLoopbackDevHost(url.hostname)) {
      return [link];
    }

    return aliases
      .map((alias) => rewriteDevServerLinkHost(link, alias))
      .filter((rewritten): rewritten is DevServerLink => rewritten !== null);
  });

  return mergeDevServerLinks(rewrittenLinks);
}

export function resolveDevServerReachabilityHostname(
  options: DevServerTailscaleRewriteOptions,
): string | null {
  return (
    resolveTailscaleDevServerHostAliases(options)[0]?.hostname ?? options.browserHostname ?? null
  );
}

export function detectDevServerLinksFromText(text: string): DevServerLink[] {
  const candidatesByUrl = new Map<string, DevServerCandidate>();
  const lines = normalizeTerminalTextForLinkDetection(text).split(/\n/);

  lines.forEach((line, lineIndex) => {
    const context = contextWithoutUrls(line);
    const links = extractTerminalLinks(line).filter((match) => match.kind === "url");

    for (const link of links) {
      const normalizedUrl = normalizeDevServerUrl(link.text);
      if (!normalizedUrl) continue;

      const parsed = parseHttpUrl(normalizedUrl);
      if (!parsed || !isDevServerCandidate(parsed, context)) continue;

      candidatesByUrl.set(normalizedUrl, {
        url: normalizedUrl,
        context,
        host: parsed.host,
        hostname: parsed.hostname,
        port: parsed.port,
        sequence: lineIndex,
      });
    }
  });

  return [...candidatesByUrl.values()]
    .toSorted((left, right) => right.sequence - left.sequence || left.url.localeCompare(right.url))
    .map(linkFromCandidate);
}

export function detectDevServerLinksFromTerminalEvents(
  entries: ReadonlyArray<TerminalEventEntry>,
): DevServerLink[] {
  const textChunksByTerminalId = new Map<string, string[]>();

  for (const entry of entries.toSorted((left, right) => left.id - right.id)) {
    const event = entry.event;
    const currentChunks = textChunksByTerminalId.get(event.terminalId) ?? [];

    switch (event.type) {
      case "started":
      case "restarted":
        textChunksByTerminalId.set(
          event.terminalId,
          event.snapshot.status === "running" && event.snapshot.history.length > 0
            ? [event.snapshot.history]
            : [],
        );
        break;
      case "output":
        textChunksByTerminalId.set(event.terminalId, [...currentChunks, event.data]);
        break;
      case "cleared":
      case "exited":
      case "error":
        textChunksByTerminalId.set(event.terminalId, []);
        break;
      case "activity":
        if (!event.hasRunningSubprocess) {
          textChunksByTerminalId.set(event.terminalId, []);
        }
        break;
    }
  }

  const text = [...textChunksByTerminalId.values()]
    .filter((chunks) => chunks.length > 0)
    .map((chunks) => chunks.join("\n"))
    .join("\n");

  return detectDevServerLinksFromText(text);
}

export function detectDevServerLinksFromTerminalSnapshots(
  snapshots: ReadonlyArray<TerminalSessionSnapshot>,
): DevServerLink[] {
  return detectDevServerLinksFromText(
    snapshots
      .filter((snapshot) => snapshot.status === "running")
      .map((snapshot) => snapshot.history)
      .filter((history) => history.length > 0)
      .join("\n"),
  );
}

export function mergeDevServerLinks(links: ReadonlyArray<DevServerLink>): DevServerLink[] {
  const linksByUrl = new Map<string, DevServerLink>();
  for (const link of links) {
    if (!linksByUrl.has(link.url)) {
      linksByUrl.set(link.url, link);
    }
  }
  return [...linksByUrl.values()];
}

export function canCurrentBrowserReachDevServerUrl(input: {
  readonly browserHostname: string;
  readonly url: string;
}): boolean {
  const parsed = parseHttpUrl(input.url);
  if (!parsed) return false;

  const urlHost = normalizeHostname(parsed.hostname);
  const browserHost = normalizeHostname(input.browserHostname);
  if (urlHost.length === 0) return false;

  // The exact address the browser is already using is always reachable.
  if (urlHost === browserHost) return true;

  // Loopback dev servers are only reachable when the browser itself is on
  // loopback (a remote browser cannot reach the server's localhost).
  if (isLoopbackDevHost(urlHost)) {
    return isBrowserLoopbackHost(browserHost);
  }

  // Tailscale (CGNAT `100.64/10`) dev servers are reachable from any tailnet
  // browser, even when the UI is served via a MagicDNS (`*.ts.net`) name rather
  // than the raw `100.x` IP that Vite prints.
  if (isTailscaleCgnatIpv4(urlHost) && isTailnetBrowserHost(browserHost)) {
    return true;
  }

  // MagicDNS names resolve inside the tailnet as well. They are especially
  // useful when a dev server only printed loopback URLs and the UI is loaded
  // from another Tailscale address.
  if (isTailscaleMagicDnsHost(urlHost) && isTailnetBrowserHost(browserHost)) {
    return true;
  }

  // Other routable hosts are server-local interfaces (Docker `172.x`, LAN
  // `10.x`/`192.168.x`). A server-side probe can connect to them, but a remote
  // browser cannot — so we don't claim reachability and avoid false positives.
  return false;
}

/**
 * Determine whether a detected dev-server URL is reachable.
 *
 * A browser `fetch` cannot reliably probe local dev servers: when the UI is
 * served over HTTPS the request is blocked as mixed content, and private-network
 * access rules block it from secure/public contexts — and with `mode: "no-cors"`
 * those failures are indistinguishable from "server down". Instead we (1) gate on
 * whether this browser's device could even route to the URL, then (2) delegate
 * the liveness check to `options.probe` (the environment's server-side probe,
 * co-located with the dev server and free of browser sandbox restrictions).
 */
export async function probeDevServerReachable(
  url: string,
  options: DevServerProbeOptions,
): Promise<boolean> {
  const browserHostname =
    options.browserHostname ?? (typeof window === "undefined" ? "" : window.location.hostname);

  if (browserHostname.length > 0 && !canCurrentBrowserReachDevServerUrl({ browserHostname, url })) {
    return false;
  }

  try {
    return await options.probe(url);
  } catch {
    return false;
  }
}
