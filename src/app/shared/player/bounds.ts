/** A rectangle in CSS pixels, relative to the viewport. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the native player needs to place its window over an element. */
export interface Bounds {
  rect: Rect;
  /** The part of `rect` that is not scrolled or clipped out of view. */
  visible: Rect | null;
  scale: number;
  /** The viewport's size in CSS pixels. The native view can be taller, for
   *  example when it reaches under the macOS title bar. */
  viewport: { width: number; height: number };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

const CLIPS = /auto|scroll|hidden|clip/;

function toRect({ x, y, width, height }: DOMRect): Rect {
  return { x, y, width, height };
}

/**
 * The element's box, clipped to the viewport and to every ancestor that clips
 * its overflow, so the native window never covers UI outside the player.
 */
export function measure(element: HTMLElement): Bounds {
  const rect = toRect(element.getBoundingClientRect());
  let visible = intersect(rect, {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  // A fixed element (the fullscreen player) escapes its ancestors' clipping.
  const fixed = getComputedStyle(element).position === 'fixed';
  for (
    let parent = fixed ? null : element.parentElement;
    parent && visible;
    parent = parent.parentElement
  ) {
    if (CLIPS.test(getComputedStyle(parent).overflow)) {
      visible = intersect(visible, toRect(parent.getBoundingClientRect()));
    }
  }
  return {
    rect,
    visible,
    scale: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}
