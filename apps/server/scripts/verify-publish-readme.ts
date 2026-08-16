const MarkdownDestinationPattern = /!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g;
const HtmlDestinationPattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const AbsoluteDestinationPattern = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

export class PublishReadmeVerificationError extends Error {
  override readonly name = "PublishReadmeVerificationError";
}

function repositoryRelativeDestinations(readme: string): ReadonlyArray<string> {
  const destinations = new Set<string>();

  for (const pattern of [MarkdownDestinationPattern, HtmlDestinationPattern]) {
    pattern.lastIndex = 0;
    for (const match of readme.matchAll(pattern)) {
      const destination = match[1];
      if (destination && !AbsoluteDestinationPattern.test(destination)) {
        destinations.add(destination);
      }
    }
  }

  return [...destinations];
}

export function assertPortablePublishReadme(readme: string, readmePath: string): void {
  const relativeDestinations = repositoryRelativeDestinations(readme);
  if (relativeDestinations.length === 0) return;

  throw new PublishReadmeVerificationError(
    `${readmePath} contains repository-relative URLs that npm resolves from apps/server: ` +
      `${relativeDestinations.join(", ")}. Use absolute public URLs instead.`,
  );
}
