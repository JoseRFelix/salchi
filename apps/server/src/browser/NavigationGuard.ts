const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);
const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "fd00:ec2::254",
]);

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
  return (
    (WILDCARD_HOSTS.has(configuredHost) || LOOPBACK_HOSTS.has(configuredHost)) &&
    LOOPBACK_HOSTS.has(host)
  );
}
