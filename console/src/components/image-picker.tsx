"use client";

import { useRef, useState } from "react";

import { dataUriKilobytes, imageToSealableDataUri } from "@/lib/image";

/**
 * Picks the image that gets sealed into an asset id. Oversized files are
 * resized and re-encoded in the page BEFORE hashing, so the preview shown
 * here is exactly what will be stored, served and verified.
 *
 * Empty it reads as an invitation (click or drop); filled it reads as a
 * ledger row: the sealed thumbnail, what it weighs, and two plain actions.
 */
export function ImagePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (dataUri: string | null) => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function accept(file: File | undefined) {
    setError(null);
    setNote(null);
    if (!file) return;
    setBusy(true);
    const result = await imageToSealableDataUri(file);
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onChange(result.dataUri);
    setNote(
      result.compressed
        ? `compressed to ${dataUriKilobytes(result.dataUri)} KB before sealing`
        : `${dataUriKilobytes(result.dataUri)} KB`,
    );
  }

  function clear() {
    onChange(null);
    setError(null);
    setNote(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => void accept(event.target.files?.[0])}
      />

      {value ? (
        <div className="flex items-center gap-3 rounded-md border border-white/10 bg-black/20 p-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt="Image that will be sealed into the asset"
            className="h-11 w-11 shrink-0 rounded-sm border border-white/10 object-cover"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] text-neutral-300">Image sealed with the asset</span>
            <span className="font-data block text-[11px] text-neutral-500">{note}</span>
          </span>
          <span className="flex shrink-0 items-center gap-3 text-xs">
            <button
              type="button"
              className="text-neutral-400 underline decoration-white/20 underline-offset-2 transition hover:text-[#e8b23a]"
              onClick={() => fileInput.current?.click()}
            >
              Replace
            </button>
            <button
              type="button"
              className="text-neutral-500 underline decoration-white/20 underline-offset-2 transition hover:text-red-400"
              onClick={clear}
            >
              Remove
            </button>
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void accept(event.dataTransfer.files?.[0]);
          }}
          className={`flex w-full items-center gap-3 rounded-md border border-dashed px-3.5 py-3 text-left transition ${
            dragging
              ? "border-[#e8b23a]/60 bg-[#e8b23a]/[0.05]"
              : "border-white/15 hover:border-white/30 hover:bg-white/[0.02]"
          }`}
        >
          <span
            aria-hidden
            className="font-data flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-dashed border-white/15 text-lg text-neutral-600"
          >
            +
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] text-neutral-300">
              {busy ? "Preparing the image…" : "Add an image"}
            </span>
            <span className="block text-[11px] leading-snug text-neutral-500">
              PNG, JPEG, WebP or GIF. Drop one here; large files are resized before sealing.
            </span>
          </span>
        </button>
      )}

      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
