"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_REGISTRY,
  REGISTRIES,
  REGISTRY_STORAGE_KEY,
  chosenRegistry,
} from "@/lib/registries";

/**
 * Pick which registry this console reads; hidden when the build knows one.
 * Switching reloads the page, since the API client is created once.
 */
export function RegistrySwitch() {
  // The server renders the default; the stored choice is only known here.
  const [current, setCurrent] = useState(DEFAULT_REGISTRY);
  useEffect(() => setCurrent(chosenRegistry()), []);

  if (REGISTRIES.length < 2) return null;

  const choose = (registry: string) => {
    try {
      if (registry === DEFAULT_REGISTRY) window.localStorage.removeItem(REGISTRY_STORAGE_KEY);
      else window.localStorage.setItem(REGISTRY_STORAGE_KEY, registry);
    } catch {
      return; // storage unavailable: the default stays
    }
    window.location.reload();
  };

  return (
    <label className="font-data mt-4 flex flex-wrap items-center gap-2 text-[13px] text-neutral-500">
      <span>Registry</span>
      <select
        data-testid="registry-switch"
        value={current}
        onChange={(event) => choose(event.target.value)}
        className="rounded-[2px] border border-line bg-ground px-2 py-1 text-[13px] text-neutral-200 outline-none focus:border-accent/60"
      >
        {REGISTRIES.map((registry) => (
          <option key={registry} value={registry}>
            {new URL(registry).host}
            {registry === DEFAULT_REGISTRY ? " (default)" : ""}
          </option>
        ))}
      </select>
      <span className="basis-full text-neutral-600">
        On an asset&apos;s page, the name, text and image are checked in your browser, whichever
        registry serves them. Lists, supplies and history are that registry&apos;s reading of the
        chain.
      </span>
    </label>
  );
}
