"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useRef, useState } from "react";

interface ColumnResizeHandleProps {
  /** Header label, used for the accessible name. */
  columnHeader: string;
  /** Current width in pixels (optional — unset until the user resizes). */
  width?: number;
  /** Minimum width in pixels. */
  minWidth?: number;
  /** Called with the new width in pixels. */
  onResize: (width: number) => void;
}

const KEYBOARD_STEP = 16;

/**
 * Column resize handle rendered at the edge of a table header.
 *
 * Pointer users can drag it; keyboard users focus it and use the arrow keys
 * (or Home for the minimum width). Every change is reported through
 * `onResize`, which the table surfaces in its live region.
 */
export default function ColumnResizeHandle({
  columnHeader,
  width,
  minWidth = 80,
  onResize,
}: ColumnResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const handleRef = useRef<HTMLDivElement>(null);

  const clamp = useCallback((value: number) => Math.max(minWidth, Math.round(value)), [minWidth]);

  // Current width: prefer the explicit value; fall back to the laid-out cell
  // width, then the minimum. Tables should pass their effective width
  // (user width or column default) so this stays deterministic.
  const currentWidth = useCallback(
    () => width ?? handleRef.current?.closest("th")?.getBoundingClientRect().width ?? minWidth,
    [width, minWidth]
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      startXRef.current = event.clientX;
      startWidthRef.current = currentWidth();
      setDragging(true);
      handleRef.current?.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [currentWidth]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      onResize(clamp(startWidthRef.current + (event.clientX - startXRef.current)));
    },
    [dragging, clamp, onResize]
  );

  const stopDragging = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setDragging(false);
      handleRef.current?.releasePointerCapture(event.pointerId);
    },
    [dragging]
  );

  // While dragging, also react to pointer leaving the window.
  useEffect(() => {
    if (!dragging) return;
    function onPointerUp() {
      setDragging(false);
    }
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, [dragging]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowLeft":
        onResize(clamp(currentWidth() - KEYBOARD_STEP));
        event.preventDefault();
        break;
      case "ArrowRight":
        onResize(clamp(currentWidth() + KEYBOARD_STEP));
        event.preventDefault();
        break;
      case "Home":
        onResize(minWidth);
        event.preventDefault();
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${columnHeader} column`}
      aria-valuenow={width ?? undefined}
      aria-valuemin={minWidth}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDragging}
      onKeyDown={onKeyDown}
      className={`absolute inset-y-0 right-0 w-1.5 -mr-0.5 cursor-col-resize touch-none select-none focus:outline-none focus-visible:bg-[var(--accent-primary)]/60 ${
        dragging ? "bg-[var(--accent-primary)]" : "hover:bg-[var(--accent-primary)]/40"
      }`}
    />
  );
}
