"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A figure that counts up to its value the first time it is known, then
 * follows it without ceremony. The real number is what a screen reader and
 * a reduced-motion visitor get from the start.
 */
export function CountUp({ value, durationMs = 900 }: { value: number; durationMs?: number }) {
  const [shown, setShown] = useState(value);
  const played = useRef(false);

  useEffect(() => {
    const still =
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (played.current || still || value <= 0) {
      setShown(value);
      return;
    }
    played.current = true;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out cubic: fast, then settling on the exact value
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return (
    <>
      <span aria-hidden>{shown.toLocaleString("en-US")}</span>
      <span className="sr-only">{value.toLocaleString("en-US")}</span>
    </>
  );
}
