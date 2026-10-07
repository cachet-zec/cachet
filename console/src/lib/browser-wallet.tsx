"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type Call = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

type BrowserWallet = {
  /** Run a command in the mint engine's worker (spawned on first use). */
  call: Call;
  seed: string;
  setSeed: (seed: string) => void;
  /** The visitor confirmed the phrase is saved: keys may be used. */
  seedSaved: boolean;
  setSeedSaved: (saved: boolean) => void;
  /** The issuer key this seed gives, once it reads as a phrase. */
  issuer: string | null;
  generateSeed: () => Promise<void>;
  /** Spawn the worker and compile the engine ahead of need. */
  warm: () => void;
  engineReady: boolean;
  engineThreads: number;
  provingReady: boolean;
};

const WalletContext = createContext<BrowserWallet | null>(null);

/**
 * The browser wallet shared by the pages that use keys (mint, swaps). The
 * seed is React state and nothing else: never stored, never sent. It lives
 * as long as this document does, so moving between those pages keeps it,
 * and a reload forgets it. One worker serves them all, so the engine, the
 * proving key and the wallet's scan are built once per visit.
 */
export function BrowserWalletProvider({ children }: { children: React.ReactNode }) {
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(0);
  const warmed = useRef(false);
  const provingWarmed = useRef(false);

  const [seed, setSeed] = useState("");
  const [seedSaved, setSeedSaved] = useState(false);
  const [issuer, setIssuer] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [engineThreads, setEngineThreads] = useState(1);
  const [provingReady, setProvingReady] = useState(false);

  const call = useCallback(<T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (!workerRef.current) {
      workerRef.current = new Worker("/mint-worker.js", { type: "module" });
    }
    const worker = workerRef.current;
    const id = nextId.current++;
    return new Promise<T>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        worker.removeEventListener("message", onMessage);
        if (event.data.ok) resolve(event.data.result as T);
        else reject(new Error(event.data.error));
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ id, cmd, args });
    });
  }, []);

  useEffect(
    () => () => {
      // Forget it as well as stop it: a remount (React's development double
      // mount, for one) would otherwise keep talking to a dead worker.
      workerRef.current?.terminate();
      workerRef.current = null;
      warmed.current = false;
      provingWarmed.current = false;
    },
    [],
  );

  // On cross-origin-isolated pages the worker picks the threaded build;
  // the pool size lets progress copy be honest about speed.
  const warm = useCallback(() => {
    if (warmed.current) return;
    warmed.current = true;
    call<{ threads: number }>("engine_info")
      .then((info) => {
        setEngineThreads(info.threads);
        setEngineReady(true);
      })
      .catch(() => {
        warmed.current = false;
      });
  }, [call]);

  const generateSeed = useCallback(async () => {
    const generated = await call<{ seed: string }>("generate_seed");
    setSeed(generated.seed);
    setSeedSaved(false);
  }, [call]);

  // Once the phrase is saved, build the proving key: seconds of work that
  // do not depend on the seed, done while the visitor fills in a form.
  useEffect(() => {
    if (!seedSaved || provingWarmed.current) return;
    provingWarmed.current = true;
    call("prepare_proving")
      .then(() => setProvingReady(true))
      .catch(() => {
        provingWarmed.current = false;
      });
  }, [seedSaved, call]);

  // Derive the issuer identity whenever a plausible seed is present.
  useEffect(() => {
    const words = seed.trim().split(/\s+/).length;
    if (words !== 24 && words !== 12) {
      setIssuer(null);
      return;
    }
    let cancelled = false;
    call<{ issuer: string }>("issuer_info", { seed: seed.trim(), description: "probe" })
      .then((info) => !cancelled && setIssuer(info.issuer))
      .catch(() => !cancelled && setIssuer(null));
    return () => {
      cancelled = true;
    };
  }, [seed, call]);

  return (
    <WalletContext.Provider
      value={{
        call,
        seed,
        setSeed,
        seedSaved,
        setSeedSaved,
        issuer,
        generateSeed,
        warm,
        engineReady,
        engineThreads,
        provingReady,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useBrowserWallet(): BrowserWallet {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useBrowserWallet outside BrowserWalletProvider");
  return wallet;
}
