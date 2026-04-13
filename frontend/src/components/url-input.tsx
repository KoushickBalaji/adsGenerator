"use client";

import { useState } from "react";

type Props = {
  onSubmit: (url: string) => void;
  disabled: boolean;
  placeholder?: string;
  helperText?: string;
  initialValue?: string;
};

export function UrlInput({ onSubmit, disabled, placeholder, helperText, initialValue }: Props) {
  const [url, setUrl] = useState(initialValue || "");
  const [error, setError] = useState("");

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

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex gap-3">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={placeholder || "https://example.com/product/..."}
          disabled={disabled}
          className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
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
        <p className="mt-2 text-sm text-red-500">{error}</p>
      ) : (
        <p className="mt-2 text-xs text-zinc-400">
          {helperText || "Paste a product URL to generate a short video ad."}
        </p>
      )}
    </form>
  );
}
