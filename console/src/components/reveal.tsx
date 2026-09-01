"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A section that plays its entrance when it first becomes visible, not on
 * page load - an entrance played off-screen is an entrance nobody saw.
 * Fires once; the settled state is permanent.
 *
 * Motion is a progressive enhancement here: without JavaScript or
 * IntersectionObserver the content is simply visible (the hidden initial
 * state lives behind `prefers-reduced-motion: no-preference` and is lifted
 * the moment the observer cannot exist).
 */
export function Reveal({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      // A fifth of the section, or its first 160px for tall ones: enough
      // that the motion happens where the reader is actually looking.
      { threshold: 0.2, rootMargin: "0px 0px -60px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={ref} className={`reveal ${inView ? "in-view" : ""} ${className}`}>
      {children}
    </section>
  );
}
