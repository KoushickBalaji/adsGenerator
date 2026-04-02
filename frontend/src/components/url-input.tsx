"use client";

import { useState } from "react";

type Props = {
  onSubmit: (url: string) => void;
  disabled: boolean;
};

export function UrlInput({ onSubmit, disabled }: Props) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!url.trim()) {
      setError("Please enter a URL");
      return;
    }

    try {
      const parsed = new URL(url.trim());
      if (!parsed.hostname.includes("bluestone.com")) {
        setError("Please enter a BlueStone product URL");
        return;
      }
    } catch {
      setError("Please enter a valid URL");
      return;
    }

    onSubmit(url.trim());
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex gap-3">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.bluestone.com/rings/..."
          disabled={disabled}
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled}
          className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600"
        >
          {disabled ? "Generating..." : "Generate Video"}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      ) : (
        <p className="mt-2 text-xs text-zinc-500">Copy and paste the URL of any jewel from BlueStone</p>
      )}
    </form>
  );
}
