"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { detectCompanyFromUrl } from "@/lib/company";

export function DemoRedirectForm() {
  const router = useRouter();

  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      setError("Please enter a product URL.");
      return;
    }

    try {
      new URL(trimmedUrl);
    } catch {
      setError("Please enter a valid URL.");
      return;
    }

    const companySlug = detectCompanyFromUrl(trimmedUrl);
    if (!companySlug) {
      setError(
        "We don\u2019t recognize this store yet. Reach out to get your brand set up."
      );
      return;
    }

    router.push(
      `/demo/${companySlug}?url=${encodeURIComponent(trimmedUrl)}&autostart=1`
    );
  }

  return (
    <section className="mt-14 rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-10 shadow-2xl">
      <h2 className="text-xl font-semibold text-zinc-100">
        See it work on your products
      </h2>
      <p className="mt-2 text-sm text-zinc-400">
        Paste a product URL from your store to generate a video ad instantly.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError("");
            }}
            placeholder="https://www.yourstore.com/product/..."
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white transition-colors hover:bg-blue-500"
          >
            Generate Video
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>

      <p className="mt-4 text-xs text-zinc-500">
        This is a shared demo environment. Reach out to get your brand set up.
      </p>
    </section>
  );
}
