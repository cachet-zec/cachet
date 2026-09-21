/**
 * Shared className recipes — the console's design language.
 *
 * Direction: security print. Bottle-green stock, banknote-ivory ink,
 * engraved display type, monospace only for data, one copper accent used
 * sparingly. Depth comes from hairlines; nothing under 13px, and labels
 * only where they carry information.
 */

export const card =
  "rounded-[3px] border border-line bg-surface p-5 sm:p-6 " +
  "[background-image:linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0)_45%)] " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_3px_rgba(0,0,0,0.35)]";

export const cardTitle = "font-display text-xl font-medium text-neutral-100";

export const label = "text-sm font-medium text-neutral-300";

/** The caption above a datum (an id, a key, a hash): quiet, never a heading. */
export const fieldLabel = "font-data text-sm text-neutral-400";

// text-base on mobile: below 16px, iOS zooms the page on input focus.
export const input =
  "w-full rounded-md border border-white/10 bg-black/30 px-3.5 py-2.5 font-data text-base sm:text-sm " +
  "text-neutral-100 placeholder:text-neutral-600 outline-none transition " +
  "shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] " +
  "focus:border-accent/60 focus:ring-1 focus:ring-accent/30";

export const primaryButton =
  "rounded-[2px] bg-accent px-6 py-3 text-base font-semibold text-ground transition " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_1px_2px_rgba(0,0,0,0.45)] " +
  "hover:-translate-y-px hover:bg-accent-hover active:translate-y-px active:bg-accent-active " +
  "disabled:opacity-40 disabled:hover:translate-y-0";

export const ghostButton =
  "rounded-[2px] border border-line-strong px-5 py-3 text-base text-neutral-200 transition " +
  "hover:border-accent/60 hover:bg-white/[0.03] hover:text-accent " +
  "active:translate-y-px disabled:opacity-40";

export const dangerButton =
  "rounded-md border border-red-400/40 px-5 py-2.5 text-sm font-semibold text-red-300 " +
  "transition hover:bg-red-400/10 hover:border-red-400/70 active:translate-y-px " +
  "disabled:opacity-40";

export const mono = "break-all font-data text-[13px] text-neutral-500";

/**
 * A stamp for a fact the reader should weigh, not one that is wrong: the
 * copper accent is the interface's attention colour, red is reserved for failures. An
 * asset whose issuer can still mint more is not defective - the holder
 * simply needs to see it.
 */
export const stampNotable =
  "rounded-full border border-accent/60 px-3 py-0.5 font-data text-[13px] " +
  "tracking-[0.04em] text-accent";

/** Small stamped tag, e.g. FINALIZED. */
export const stamp =
  "rounded-full border border-neutral-600 px-3 py-0.5 font-data text-[13px] " +
  "tracking-[0.04em] text-neutral-300";

/** The ledger's numbered left column: a ruled margin, like an account book. */
export const rowIndex =
  "font-data w-9 shrink-0 border-r border-white/[0.06] pr-2.5 text-right text-[13px] text-neutral-600";
