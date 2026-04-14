"use client";

import type { VideoRun } from "@/lib/supabase";

type Props = {
  runs: VideoRun[];
  onSelect: (run: VideoRun) => void;
  selectedId: string | null;
};

export function HistoryList({ runs, onSelect, selectedId }: Props) {
  if (runs.length === 0) {
    return (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-8 text-center">
        <p className="text-zinc-400">No videos generated yet.</p>
        <p className="mt-1 text-sm text-zinc-400">
          Paste a product URL above to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <button
          key={run.id}
          onClick={() => onSelect(run)}
          className={`w-full rounded-lg border p-4 text-left transition-colors ${
            selectedId === run.id
              ? "border-blue-500 bg-blue-50"
              : "border-zinc-200 bg-white hover:bg-zinc-50"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-800 truncate max-w-[70%]">
              {run.product_title || run.source_url}
            </span>
            <StatusBadge status={run.status} />
          </div>
          {run.product_category && (
            <div className="mt-1 text-xs text-zinc-400 capitalize">
              {run.product_category}
            </div>
          )}
          {run.status === "completed" && run.thumbnail_url && (
            <img
              src={run.thumbnail_url}
              alt=""
              className="mt-2 h-16 w-full rounded object-cover"
            />
          )}
        </button>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: VideoRun["status"] }) {
  const styles: Record<VideoRun["status"], string> = {
    queued: "bg-yellow-50 text-yellow-600",
    processing: "bg-blue-50 text-blue-600",
    completed: "bg-green-50 text-green-600",
    failed: "bg-red-50 text-red-600",
  };

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}
