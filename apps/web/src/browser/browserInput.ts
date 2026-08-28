export const BROWSER_INPUT_MODIFIER_ALT = 1;
export const BROWSER_INPUT_MODIFIER_CONTROL = 2;
export const BROWSER_INPUT_MODIFIER_META = 4;
export const BROWSER_INPUT_MODIFIER_SHIFT = 8;

export interface BrowserFrameLayout {
  readonly drawHeight: number;
  readonly drawWidth: number;
  readonly drawX: number;
  readonly drawY: number;
  readonly scale: number;
}

export interface BrowserCanvasBounds {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export interface BrowserFramePoint {
  readonly x: number;
  readonly y: number;
}

export function computeBrowserFrameLayout(
  viewportWidth: number,
  viewportHeight: number,
  frameWidth: number,
  frameHeight: number,
): BrowserFrameLayout | null {
  if (viewportWidth <= 0 || viewportHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) {
    return null;
  }
  const scale = Math.min(viewportWidth / frameWidth, viewportHeight / frameHeight);
  const drawWidth = frameWidth * scale;
  const drawHeight = frameHeight * scale;
  return {
    scale,
    drawWidth,
    drawHeight,
    drawX: (viewportWidth - drawWidth) / 2,
    drawY: (viewportHeight - drawHeight) / 2,
  };
}

export function mapCanvasPointToBrowserFrame(input: {
  readonly bounds: BrowserCanvasBounds;
  readonly clampToFrame?: boolean;
  readonly clientX: number;
  readonly clientY: number;
  readonly devicePixelRatio: number;
  readonly frameHeight: number;
  readonly frameWidth: number;
}): BrowserFramePoint | null {
  const pixelRatio = Math.max(1, input.devicePixelRatio || 1);
  const layout = computeBrowserFrameLayout(
    input.bounds.width * pixelRatio,
    input.bounds.height * pixelRatio,
    input.frameWidth,
    input.frameHeight,
  );
  if (layout === null) return null;

  const canvasX = (input.clientX - input.bounds.left) * pixelRatio;
  const canvasY = (input.clientY - input.bounds.top) * pixelRatio;
  const rawX = (canvasX - layout.drawX) / layout.scale;
  const rawY = (canvasY - layout.drawY) / layout.scale;
  const outside = rawX < 0 || rawY < 0 || rawX > input.frameWidth || rawY > input.frameHeight;
  if (outside && input.clampToFrame !== true) return null;

  return {
    x: Math.min(Math.max(rawX, 0), input.frameWidth),
    y: Math.min(Math.max(rawY, 0), input.frameHeight),
  };
}

export function browserKeyboardModifiers(input: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number {
  return (
    (input.altKey ? BROWSER_INPUT_MODIFIER_ALT : 0) |
    (input.ctrlKey ? BROWSER_INPUT_MODIFIER_CONTROL : 0) |
    (input.metaKey ? BROWSER_INPUT_MODIFIER_META : 0) |
    (input.shiftKey ? BROWSER_INPUT_MODIFIER_SHIFT : 0)
  );
}
