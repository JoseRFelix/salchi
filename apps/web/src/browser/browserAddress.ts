const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/#?]|$)/u;
const BRACKETED_IPV6_PATTERN = /^\[[\da-f:]+\](?::\d+)?(?:[/#?]|$)/iu;
const HOSTNAME_PATTERN = /^(?:localhost|(?:[a-z\d-]+\.)+[a-z\d-]+)(?::\d+)?(?:[/#?]|$)/iu;

export function browserAddressValue(url: string): string {
  const value = url.trim();
  return value === "about:blank" ? "" : value;
}

export function resolveBrowserAddress(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (
    IPV4_PATTERN.test(trimmed) ||
    BRACKETED_IPV6_PATTERN.test(trimmed) ||
    HOSTNAME_PATTERN.test(trimmed)
  ) {
    const scheme = /^(?:localhost|127(?:\.\d{1,3}){3})(?::|[/#?]|$)/iu.test(trimmed)
      ? "http"
      : "https";
    return `${scheme}://${trimmed}`;
  }

  if (EXPLICIT_SCHEME_PATTERN.test(trimmed)) return trimmed;

  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}
