const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);
const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "fd00:ec2::254",
]);

export interface BrowserFetchPattern {
  readonly urlPattern: string;
  readonly requestStage: "Request";
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function patternHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function addAllPortPatterns(patterns: Set<string>, host: string): void {
  const formattedHost = patternHost(host);
  for (const protocol of ["http", "https"] as const) {
    patterns.add(`${protocol}://${formattedHost}/*`);
    patterns.add(`${protocol}://${formattedHost}:*/*`);
  }
}

function addExactPortPatterns(patterns: Set<string>, host: string, port: number): void {
  const formattedHost = patternHost(host);
  for (const protocol of ["http", "https"] as const) {
    patterns.add(`${protocol}://${formattedHost}:${String(port)}/*`);
    if ((protocol === "http" && port === 80) || (protocol === "https" && port === 443)) {
      patterns.add(`${protocol}://${formattedHost}/*`);
    }
  }
}

/**
 * Fetch interception is intentionally restricted to requests the navigation
 * guard may reject. A catch-all pattern would pause every page subresource in
 * Node before Chromium could continue it.
 */
export function browserFetchInterceptionPatterns(input: {
  readonly serverHost?: string | undefined;
  readonly serverPort: number;
}): Array<BrowserFetchPattern> {
  const patterns = new Set<string>();
  for (const host of BLOCKED_METADATA_HOSTS) addAllPortPatterns(patterns, host);

  const configuredHost = normalizeHost(input.serverHost ?? "127.0.0.1");
  const salchiHosts = new Set(LOOPBACK_HOSTS);
  if (!WILDCARD_HOSTS.has(configuredHost)) salchiHosts.add(configuredHost);
  for (const host of salchiHosts) addExactPortPatterns(patterns, host, input.serverPort);

  return [...patterns].map((urlPattern) => ({ urlPattern, requestStage: "Request" }));
}

export function shouldBlockBrowserRequest(input: {
  readonly url: string;
  readonly serverHost?: string | undefined;
  readonly serverPort: number;
}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return false;
  }

  const host = normalizeHost(parsed.hostname);
  if (BLOCKED_METADATA_HOSTS.has(host)) return true;
  if (effectivePort(parsed) !== input.serverPort) return false;

  const configuredHost = normalizeHost(input.serverHost ?? "127.0.0.1");
  if (host === configuredHost) return true;
  return LOOPBACK_HOSTS.has(host);
}
