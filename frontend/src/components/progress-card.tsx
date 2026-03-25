"use client";

import type { VideoRun } from "@/lib/supabase";

type Props = {
  run: VideoRun;
  onRefresh: () => void;
};

const STATUS_LABELS: Record<VideoRun["status"], string> = {
  queued: "Queued",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_COLORS: Record<VideoRun["status"], string> = {
  queued: "text-yellow-400",
  processing: "text-blue-400",
  completed: "text-green-400",
  failed: "text-red-400",
};

export function ProgressCard({ run, onRefresh }: Props) {
  const isActive = run.status === "queued" || run.status === "processing";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-medium text-zinc-100">
            {run.product_title || "Loading product details..."}
          </h3>
          {run.product_category && (
            <span className="text-sm text-zinc-500 capitalize">
              {run.product_category}
            </span>
          )}
        </div>
        <span className={`text-sm font-medium ${STATUS_COLORS[run.status]}`}>
          {STATUS_LABELS[run.status]}
        </span>
      </div>

      {isActive && (
        <div className="mb-4">
          <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-1000 ${
                run.status === "queued"
                  ? "w-1/4 bg-yellow-500"
                  : "w-3/4 bg-blue-500 animate-pulse"
              }`}
            />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-sm text-zinc-400">
              {run.status === "queued"
                ? "Waiting for video generation to start..."
                : "Video is being generated..."}
            </p>
            {run.status === "processing" && (
              <button
                onClick={onRefresh}
                className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Refresh status
              </button>
            )}
          </div>
        </div>
      )}

      {run.status === "completed" && run.output_video_url && (
        <div className="space-y-3">
          <video
            src={run.output_video_url}
            controls
            className="w-full rounded-lg"
            poster={run.thumbnail_url || undefined}
          />
          <a
            href={run.output_video_url}
            download
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Download MP4
          </a>
        </div>
      )}

      {run.status === "failed" && (
        <p className="text-sm text-red-400">
          {run.error_message || "Generation failed. Please try again."}
        </p>
      )}
    </div>
  );
}
