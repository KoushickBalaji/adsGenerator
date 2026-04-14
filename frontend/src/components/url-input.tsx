"use client";

import { useState } from "react";

type Props = {
  onSubmit: (url: string) => void;
  onTryRandom?: () => Promise<string>;
  disabled: boolean;
  placeholder?: string;
  helperText?: string;
  initialValue?: string;
};

export function UrlInput({
  onSubmit,
  onTryRandom,
  disabled,
  placeholder,
  helperText,
  initialValue,
}: Props) {
  const [url, setUrl] = useState(initialValue || "");
  const [error, setError] = useState("");
  const [findingRandom, setFindingRandom] = useState(false);

  const randomFriendlyError =
    "We are facing difficulties extracting a random item. Could you copy paste a URL manually?";

  const busy = disabled || findingRandom;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const trimmed = url.trim();
    if (!trimmed) {
      setError("Please enter a URL");
      return;
    }

    try {
      new URL(trimmed);
    } catch {
      setError("Please enter a valid URL");
      return;
    }

    onSubmit(trimmed);
  }

  async function handleTryRandom() {
    if (!onTryRandom) return;
    setError("");
    setFindingRandom(true);
    try {
      const picked = await onTryRandom();
      const trimmed = String(picked || "").trim();
      if (!trimmed) throw new Error("Couldn't find a random product right now.");
      setUrl(trimmed);
      onSubmit(trimmed);
    } catch (err) {
      console.warn("[try-random] failed:", err);
      setError(randomFriendlyError);
    } finally {
      setFindingRandom(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      {onTryRandom && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={handleTryRandom}
            disabled={busy}
            className="w-full max-w-xs rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600"
          >
            {findingRandom ? "Finding item..." : "Generate for a random item"}
          </button>
        </div>
      )}

      <div className={`flex items-center justify-center gap-3 ${onTryRandom ? "mt-3" : ""}`}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={placeholder || "https://example.com/product/..."}
          disabled={busy}
          className="w-full max-w-xl rounded-lg border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600"
        >
          {disabled ? "Generating..." : "Generate Video"}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-sm font-medium text-red-500">{error}</p>
      ) : (
        <p className="mt-2 text-sm font-medium text-zinc-600">
          {helperText || "Paste a product URL to generate a short video ad."}
        </p>
      )}
    </form>
  );
}
