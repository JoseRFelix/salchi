export const BROWSER_STEALTH_WEBDRIVER_SCRIPT = `
Object.defineProperty(Navigator.prototype, "webdriver", {
  configurable: true,
  get: () => undefined,
});
`;

/** Uses the launched browser's own current version while removing the headless product marker. */
export function browserStealthUserAgent(userAgent: string): string {
  return userAgent.replace(/\bHeadlessChrome\//g, "Chrome/");
}
