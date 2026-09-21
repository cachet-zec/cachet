"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * A sealed description, as its issuer wrote it. Up to 4096 bytes of it, and
 * nothing stops those from being two hundred line breaks: left at full
 * length it would push the checks, which are the point of the page, screens
 * away. So it is shown to a fixed height, and the reader opens the rest.
 * The text itself is never cut or altered, only folded.
 */
export function SealedText({ text, className = "" }: { text: string; className?: string }) {
  const paragraph = useRef<HTMLParagraphElement | null>(null);
  const [open, setOpen] = useState(false);
  const [folds, setFolds] = useState(false);

  // Whether there is more than the folded height shows: measured, since it
  // depends on the width and the font, not on a character count.
  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element || open) return;
    const measure = () => setFolds(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <div className={className}>
      <p
        ref={paragraph}
        data-testid="sealed-text"
        className={`max-w-prose whitespace-pre-wrap text-lg leading-relaxed text-neutral-200 [overflow-wrap:anywhere] ${
          open ? "" : "max-h-[15.5rem] overflow-hidden"
        } ${folds && !open ? "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}`}
      >
        {text}
      </p>
      {(folds || open) && (
        <button
          type="button"
          data-testid="sealed-text-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-2 text-sm text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent"
        >
          {open ? "Fold" : "Read all"}
        </button>
      )}
    </div>
  );
}
