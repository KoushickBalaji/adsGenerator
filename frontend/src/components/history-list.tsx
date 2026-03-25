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
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center">
        <p className="text-zinc-500">No videos generated yet.</p>
        <p className="mt-1 text-sm text-zinc-600">
          Paste a BlueStone product URL above to get started.
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
              ? "border-blue-600 bg-zinc-800"
              : "border-zinc-800 bg-zinc-900 hover:bg-zinc-800/60"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-200 truncate max-w-[70%]">
              {run.product_title || run.source_url}
            </span>
            <StatusBadge status={run.status} />
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500">
            <span>{new Date(run.created_at).toLocaleDateString()}</span>
            {run.product_category && (
              <span className="capitalize">{run.product_category}</span>
            )}
          </div>
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
    queued: "bg-yellow-500/10 text-yellow-400",
    processing: "bg-blue-500/10 text-blue-400",
    completed: "bg-green-500/10 text-green-400",
    failed: "bg-red-500/10 text-red-400",
  };

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}
