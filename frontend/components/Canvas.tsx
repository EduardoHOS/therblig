'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const LIMIT = { min: 0.1, max: 6 };
const clamp = (value: number) => Math.min(LIMIT.max, Math.max(LIMIT.min, value));

/**
 * Pan, zoom and selection over an SVG the server drew. The diagram's coordinates come from the
 * file's own DI, so nothing here lays anything out — it only decides what you are looking at.
 */
export function Canvas({
  svg,
  selected,
  onSelect,
}: {
  svg: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  // What was under the pointer when it went down, and how far it has travelled since. Capturing the
  // pointer retargets every later pointer event — and the click the browser derives from them — at
  // the frame, so a hit test done afterwards always finds the frame and never a shape. The test has
  // to happen on the way down, and the selection is committed on the way up only if this was a
  // click rather than the start of a drag.
  const pressed = useRef<{ id: string | null; x: number; y: number; moved: number } | null>(null);

  const fit = useCallback(() => {
    const node = frame.current?.querySelector('svg');
    const rect = frame.current?.getBoundingClientRect();
    if (!node || !rect) return;
    const box = node.viewBox.baseVal;
    const scale = clamp(
      Math.min(1.6, (rect.width - 72) / box.width, (rect.height - 72) / box.height),
    );
    setView({
      scale,
      x: (rect.width - box.width * scale) / 2,
      y: (rect.height - box.height * scale) / 2,
    });
  }, []);

  useEffect(fit, [fit, svg]);

  /** Zoom about a point in frame coordinates, keeping whatever is under it where it is. */
  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect) return;
    const [ax, ay] = [px ?? rect.width / 2, py ?? rect.height / 2];
    setView((v) => {
      const next = clamp(v.scale * factor);
      return {
        scale: next,
        x: ax - ((ax - v.x) * next) / v.scale,
        y: ay - ((ay - v.y) * next) / v.scale,
      };
    });
  }, []);

  /**
   * The wheel is handled natively rather than through React, because React registers its wheel
   * listener as passive: `preventDefault` there is ignored and the browser keeps the gesture, so a
   * pinch zooms the whole page instead of the diagram. That is the bug this replaces.
   *
   * A plain wheel pans, the way a canvas does; ⌘/ctrl-wheel — which is also what a trackpad pinch
   * sends — zooms about the pointer, so what is under the cursor stays under it.
   */
  useEffect(() => {
    const node = frame.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY / 300), event.clientX - rect.left, event.clientY - rect.top);
        return;
      }
      const [dx, dy] = event.shiftKey ? [-event.deltaY, 0] : [-event.deltaX, -event.deltaY];
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Selection is a class on the drawn element, so it survives pan and zoom for free.
  useEffect(() => {
    const root = frame.current;
    if (!root) return;
    for (const drawn of root.querySelectorAll('[data-id]')) {
      drawn.classList.toggle('is-selected', drawn.getAttribute('data-id') === selected);
    }
  }, [selected, svg]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'Escape') onSelect(null);
      if (event.key === '0') fit();
      if (event.key === '+' || event.key === '=') zoomAt(1.2);
      if (event.key === '-' || event.key === '_') zoomAt(1 / 1.2);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [fit, onSelect, zoomAt]);

  return (
    <div
      ref={frame}
      className={`canvas-ground relative h-full touch-none overflow-hidden ${
        dragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      onPointerDown={(event) => {
        // A press that starts on the toolbar is not a press on the diagram. Capturing the pointer
        // here would retarget the click at this frame and the button would never receive it —
        // which is why zooming with the wheel worked while the buttons did nothing.
        if ((event.target as Element).closest('[data-canvas-ui]')) return;
        setDragging(true);
        last.current = { x: event.clientX, y: event.clientY };
        const hit = (event.target as Element).closest('[data-id]');
        pressed.current = {
          id: hit?.getAttribute('data-id') ?? null,
          x: event.clientX,
          y: event.clientY,
          moved: 0,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        // Four pixels of slack: a click with a shaking hand is still a click, and a drag that
        // happens to end over a shape is still a drag.
        if (pressed.current && pressed.current.moved < 4) onSelect(pressed.current.id);
        pressed.current = null;
      }}
      onPointerMove={(event) => {
        if (!dragging || !last.current) return;
        const dx = event.clientX - last.current.x;
        const dy = event.clientY - last.current.y;
        last.current = { x: event.clientX, y: event.clientY };
        if (pressed.current) {
          pressed.current.moved = Math.hypot(
            event.clientX - pressed.current.x,
            event.clientY - pressed.current.y,
          );
        }
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }}
    >
      <div
        className="canvas-sheet absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />

      <div
        data-canvas-ui
        className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-4"
      >
        <p className="hidden rounded-md border border-rule/60 bg-surface/70 px-2.5 py-1 text-[11px] text-ink-3 backdrop-blur-sm sm:block">
          drag to pan · pinch or ctrl-scroll to zoom · click to inspect
        </p>

        <div className="pointer-events-auto ml-auto flex items-stretch overflow-hidden rounded-lg border border-rule bg-surface/90 text-ink-2 shadow-sm backdrop-blur-sm">
          <button type="button" onClick={() => zoomAt(1 / 1.2)} title="Zoom out (−)" className="zoom-key">
            −
          </button>
          <span className="grid w-14 place-items-center border-x border-rule text-[11px] tabular-nums">
            {Math.round(view.scale * 100)}%
          </span>
          <button type="button" onClick={() => zoomAt(1.2)} title="Zoom in (+)" className="zoom-key">
            +
          </button>
          <button
            type="button"
            onClick={fit}
            title="Fit to view (0)"
            className="zoom-key border-l border-rule px-3 text-[11px]"
          >
            fit
          </button>
        </div>
      </div>
    </div>
  );
}
