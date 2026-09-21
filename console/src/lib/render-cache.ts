/**
 * A bounded memory of expensive renders, for the asset social card.
 *
 * Drawing a card costs a few hundred milliseconds of CPU, and cards are
 * asked for in bursts: a shared link is fetched by every platform it lands
 * on, then again by each of them. Three things keep that from becoming the
 * server's main job:
 *
 *  - a render is kept for a few minutes, within a fixed byte budget, the
 *    least recently used going first;
 *  - the same card asked for twice at once is drawn once;
 *  - only so many cards are drawn at a time, a few callers wait, and the
 *    rest are told to take the site's card instead (`null`).
 *
 * A cache cannot help a crawler walking distinct assets, since every card
 * is then a first render; the last point is what bounds that case.
 *
 * Process memory only: nothing is written to disk, so ids made up by a
 * caller cannot fill one, and a restart forgets everything.
 */
/** PNG bytes on their own buffer, as a `Response` body takes them. */
export type Bytes = Uint8Array<ArrayBuffer>;
export type Rendered = { bytes: Bytes; ttlMs: number };

type Entry = { bytes: Bytes; expires: number };

export function createRenderCache(limits: {
  maxBytes: number;
  maxConcurrent: number;
  maxWaiting: number;
}) {
  // A Map iterates in insertion order: re-inserting on use makes it an LRU.
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<Bytes>>();
  const waiting: Array<() => void> = [];
  let storedBytes = 0;
  let running = 0;

  function remember(key: string, rendered: Rendered) {
    forget(key);
    if (rendered.bytes.byteLength > limits.maxBytes) return;
    entries.set(key, { bytes: rendered.bytes, expires: Date.now() + rendered.ttlMs });
    storedBytes += rendered.bytes.byteLength;
    for (const [oldest, entry] of entries) {
      if (storedBytes <= limits.maxBytes) break;
      entries.delete(oldest);
      storedBytes -= entry.bytes.byteLength;
    }
  }

  function forget(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    storedBytes -= entry.bytes.byteLength;
  }

  /** Take a drawing slot, waiting for one if the queue has room. */
  async function acquire(): Promise<boolean> {
    if (running < limits.maxConcurrent) {
      running += 1;
      return true;
    }
    if (waiting.length >= limits.maxWaiting) return false;
    // Woken by `release`, which hands its slot over: `running` stays as is.
    await new Promise<void>((resolve) => waiting.push(resolve));
    return true;
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }

  const fresh = (key: string) => {
    const kept = entries.get(key);
    if (!kept || kept.expires <= Date.now()) return null;
    entries.delete(key);
    entries.set(key, kept);
    return kept.bytes;
  };

  /** The render for `key`, or `null` when too many are already being drawn. */
  async function get(key: string, render: () => Promise<Rendered>): Promise<Bytes | null> {
    const held = fresh(key) ?? inFlight.get(key);
    if (held) return held;
    if (!(await acquire())) return null;
    // Someone may have drawn it, or started to, while this caller waited.
    const meanwhile = fresh(key) ?? inFlight.get(key);
    if (meanwhile) {
      release();
      return meanwhile;
    }
    const drawing = (async () => {
      try {
        const rendered = await render();
        remember(key, rendered);
        return rendered.bytes;
      } finally {
        inFlight.delete(key);
        release();
      }
    })();
    inFlight.set(key, drawing);
    return drawing;
  }

  return {
    get,
    /** A render already held and still fresh, without asking for one. */
    peek: fresh,
    stats: () => ({ entries: entries.size, storedBytes, running }),
  };
}
