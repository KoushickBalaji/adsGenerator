"use client";

import { useState, useEffect } from "react";
import type { VideoRun } from "@/lib/supabase";

type Props = {
  run: VideoRun;
  onRefresh: () => void;
  prefetchedVideoSrc?: string | null;
};

const STATUS_COLORS: Record<VideoRun["status"], string> = {
  queued: "text-yellow-600",
  processing: "text-blue-600",
  completed: "text-green-600",
  failed: "text-red-600",
};

// Pipeline steps shown during processing
const PIPELINE_STEPS = [
  // Timing goal: ~5 minutes total. Start fast (5-10s) then slow down in the middle.
  { label: "Getting to know the piece", icon: "search", duration: 8000 },
  { label: "Noticing the little details", icon: "gem", duration: 8000 },
  { label: "Casting the muse", icon: "user", duration: 9000 },
  { label: "Shaping the storyline", icon: "sparkle", duration: 45000 },
  { label: "Setting the scene", icon: "layout", duration: 50000 },
  { label: "Capturing the moment", icon: "film", duration: 60000 },
  { label: "Bringing it to life", icon: "clapperboard", duration: 60000 },
  { label: "Setting the mood lighting", icon: "sun", duration: 30000 },
  { label: "Adding final touches", icon: "sparkles", duration: 30000 },
];

function StepIcon({ icon, className }: { icon: string; className?: string }) {
  const cls = className || "w-4 h-4";
  switch (icon) {
    case "search":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      );
    case "gem":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 2L2 9l10 13L22 9 12 2z" />
        </svg>
      );
    case "user":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      );
    case "sparkle":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
      );
    case "layout":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 9h16M9 4v16" />
        </svg>
      );
    case "film":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
        </svg>
      );
    case "clapperboard":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      );
    case "sun":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      );
    case "sparkles":
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
        </svg>
      );
    default:
      return null;
  }
}

function ProcessingPipeline({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const interval = setInterval(() => {
      setElapsed(Date.now() - start);
    }, 500);
    return () => clearInterval(interval);
  }, [startedAt]);

  const activeStep = (() => {
    // Derive the active step from elapsed time to avoid setState in effects
    let cumulative = 0;
    for (let i = 0; i < PIPELINE_STEPS.length; i++) {
      cumulative += PIPELINE_STEPS[i].duration;
      if (elapsed < cumulative) {
        return i;
      }
    }
    // If past all steps, stay on last one
    return PIPELINE_STEPS.length - 1;
  })();

  // Calculate total progress
  const totalDuration = PIPELINE_STEPS.reduce((sum, s) => sum + s.duration, 0);
  const progress = Math.min((elapsed / totalDuration) * 100, 95); // Cap at 95% until completed
  const isOvertime = elapsed > totalDuration;

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="h-1 w-full rounded-full bg-zinc-200 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r from-blue-600 via-blue-500 to-cyan-500 transition-all duration-500 ease-out${isOvertime ? " animate-pulse" : ""}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Steps timeline */}
      <div className="space-y-1">
        {PIPELINE_STEPS.map((step, i) => {
          const isActive = i === activeStep;
          const isCompleted = i < activeStep;
          const isFuture = i > activeStep;

          return (
            <div
              key={step.label}
              className={`flex items-center gap-3 px-3 py-1.5 rounded-lg transition-all duration-500 ${
                isActive
                  ? "bg-blue-50 border border-blue-200"
                  : isCompleted
                  ? "opacity-60"
                  : "opacity-0 h-0 py-0 overflow-hidden"
              }`}
              style={{
                // Show next 2 upcoming steps faded
                ...(isFuture && i <= activeStep + 2
                  ? { opacity: 0.3, height: "auto", padding: "6px 12px", overflow: "visible" }
                  : {}),
              }}
            >
              {/* Step icon */}
              <div
                className={`flex-shrink-0 ${
                  isActive
                    ? "text-blue-600 animate-pulse"
                    : isCompleted
                    ? "text-green-600"
                    : "text-zinc-300"
                }`}
              >
                {isCompleted ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <StepIcon icon={step.icon} className="w-4 h-4" />
                )}
              </div>

              {/* Step label */}
              <span
                className={`text-sm ${
                  isActive
                    ? "text-blue-700 font-medium"
                    : isCompleted
                    ? "text-zinc-400 line-through"
                    : "text-zinc-300"
                }`}
              >
                {step.label}
                {isActive && (
                  <span className="inline-flex ml-1.5">
                    <span className="animate-bounce inline-block" style={{ animationDelay: "0ms" }}>.</span>
                    <span className="animate-bounce inline-block" style={{ animationDelay: "150ms" }}>.</span>
                    <span className="animate-bounce inline-block" style={{ animationDelay: "300ms" }}>.</span>
                  </span>
                )}
              </span>

              {/* Active spinner */}
              {isActive && (
                <div className="ml-auto flex-shrink-0">
                  <div className="w-4 h-4 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Elapsed time */}
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span>
          {Math.floor(elapsed / 60000)}:{String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0")} elapsed
        </span>
        {isOvertime ? (
          <span className="text-amber-600">Taking longer than usual &mdash; feel free to browse your other videos while we finish up</span>
        ) : (
          <span>May take a few minutes - take a look around or try another item while you wait</span>
        )}
      </div>

      {/* Overtime notice */}
      {isOvertime && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <svg className="mt-0.5 w-4 h-4 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-amber-700">
            This is taking longer than expected. Your video is still being generated &mdash; check back shortly or explore other items in your history.
          </p>
        </div>
      )}
    </div>
  );
}

export function ProgressCard({ run, onRefresh, prefetchedVideoSrc }: Props) {
  const [playbackStartedForRunId, setPlaybackStartedForRunId] = useState<string | null>(null);
  const hasStartedPlayback = playbackStartedForRunId === run.id;

  const effectiveVideoSrc =
    run.output_video_url && (hasStartedPlayback || !prefetchedVideoSrc)
      ? run.output_video_url
      : prefetchedVideoSrc || run.output_video_url;

  return (
    <div className="flex h-full flex-col rounded-xl border border-zinc-200 bg-white p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-medium text-zinc-900">
            {run.source_url ? (
              <a
                href={run.source_url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline underline-offset-2"
                title="Open product page"
              >
                {run.product_title || "Loading product details..."}
              </a>
            ) : (
              (run.product_title || "Loading product details...")
            )}
          </h3>
          {run.product_category && (
            <span className="text-sm text-zinc-400 capitalize">
              {run.product_category}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${STATUS_COLORS[run.status]}`}>
            {run.status === "queued"
              ? "Queued"
              : run.status === "processing"
              ? "Generating"
              : run.status === "completed"
              ? "Completed"
              : "Failed"}
          </span>
          {run.status === "processing" && (
            <button
              onClick={onRefresh}
              className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors border border-zinc-200 rounded px-2 py-1 hover:bg-zinc-50"
            >
              Refresh
            </button>
          )}
        </div>
      </div>

      <ShotPreviews run={run} />

      {/* Queued state */}
      {run.status === "queued" && (
        <div className="flex items-center gap-3 px-3 py-3 rounded-lg bg-yellow-50 border border-yellow-200">
          <div className="w-4 h-4 border-2 border-yellow-200 border-t-yellow-600 rounded-full animate-spin" />
          <span className="text-sm text-yellow-700">Waiting in queue...</span>
        </div>
      )}

      {/* Processing state - animated pipeline */}
      {run.status === "processing" && (
        <ProcessingPipeline startedAt={run.created_at} />
      )}

      {/* Completed state */}
      {run.status === "completed" && effectiveVideoSrc && (
        <div className="min-h-0 flex-1 relative">
          <video
            src={effectiveVideoSrc}
            preload="auto"
            controls
            controlsList="nodownload noremoteplayback"
            disablePictureInPicture
            className="h-full w-full rounded-lg object-contain"
            poster={run.thumbnail_url || undefined}
            onPlay={() => setPlaybackStartedForRunId(run.id)}
          />
          <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-black/10 bg-white/80 px-3 py-1 text-[11px] font-medium tracking-wide text-zinc-600 backdrop-blur-sm">
            Not for commercial use
          </div>
        </div>
      )}

      {/* Failed state */}
      {run.status === "failed" && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <svg className="mt-0.5 w-5 h-5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-red-700">Video generation didn&apos;t complete</p>
              <p className="mt-1 text-xs text-red-600/70">
                {run.error_message || "An unexpected issue occurred during generation. This can happen occasionally with AI-powered video creation."}
              </p>
            </div>
          </div>
          <p className="text-xs text-zinc-500">Try generating again - each attempt produces a unique result.</p>
        </div>
      )}

    </div>
  );
}

function ShotPreviews({ run }: { run: VideoRun }) {
  const images = Array.isArray(run.preview_images) ? run.preview_images : [];
  const shot1 = images[0] ? String(images[0]) : "";
  const shot2 = images[1] ? String(images[1]) : "";
  const previewError = run.preview_error ? String(run.preview_error) : "";

  if (!shot1 && !shot2 && !previewError) return null;

  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-600 tracking-wide">
          Shot Previews
        </h3>
        {previewError && (
          <span className="text-[11px] text-zinc-500">Previews unavailable</span>
        )}
      </div>

      {previewError && <p className="mt-2 text-xs text-zinc-500">{previewError}</p>}

      <div className="mt-2 grid grid-cols-2 gap-2">
        {shot1 ? (
          <a
            href={shot1}
            target="_blank"
            rel="noreferrer"
            className="group block"
            title="Shot 1 preview"
          >
            <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
              <img
                src={shot1}
                alt="Shot 1 preview"
                className="aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                loading="lazy"
              />
            </div>
            <p className="mt-1 text-center text-[11px] text-zinc-500 group-hover:text-zinc-700 transition-colors">
              Shot 1
            </p>
          </a>
        ) : (
          <div className="rounded-md border border-dashed border-zinc-200 bg-white p-6 text-center">
            <p className="text-[11px] text-zinc-400">Shot 1</p>
          </div>
        )}

        {shot2 ? (
          <a
            href={shot2}
            target="_blank"
            rel="noreferrer"
            className="group block"
            title="Shot 2 preview"
          >
            <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
              <img
                src={shot2}
                alt="Shot 2 preview"
                className="aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                loading="lazy"
              />
            </div>
            <p className="mt-1 text-center text-[11px] text-zinc-500 group-hover:text-zinc-700 transition-colors">
              Shot 2
            </p>
          </a>
        ) : (
          <div className="rounded-md border border-dashed border-zinc-200 bg-white p-6 text-center">
            <p className="text-[11px] text-zinc-400">Shot 2</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function ReferencePanel({ run }: { run: VideoRun }) {
  const scraped = Array.isArray(run.scraped_images) ? run.scraped_images : [];
  const referenceImages = Array.isArray(run.input_images) ? run.input_images : [];
  const productImages = (scraped.length > 0 ? scraped : referenceImages).filter(Boolean);

  if (productImages.length === 0 && referenceImages.length === 0) return null;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      {productImages.length > 0 && (
        <>
          <h3 className="text-sm font-medium text-zinc-600 mb-3">
            Product Images{" "}
            <span className="text-xs text-zinc-400 font-normal">
              ({productImages.length})
            </span>
          </h3>

          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-2">
              {productImages.map((url, idx) => {
                const label = `Angle ${idx + 1}`;

                return (
                  <a
                    key={`${url}-${idx}`}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="group block"
                    title={label}
                  >
                    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50">
                      <img
                        src={url}
                        alt={label}
                        referrerPolicy="no-referrer"
                        className="aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                        loading="lazy"
                      />
                    </div>
                    <p className="mt-1 text-xs text-zinc-400 group-hover:text-zinc-600 transition-colors text-center">
                      {label}
                    </p>
                  </a>
                );
              })}
            </div>
          </div>
        </>
      )}

      {referenceImages.length > 0 && (
        <div className={productImages.length > 0 ? "mt-4" : ""}>
          <h4 className="text-xs font-semibold text-zinc-500 tracking-wide">
            Reference Images <span className="font-normal text-zinc-400">(sent to Kling)</span>
          </h4>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {referenceImages.slice(0, 4).map((url, idx) => {
              const label = `Ref ${idx + 1}`;
              return (
                <a
                  key={`${url}-${idx}`}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="group block"
                  title={label}
                >
                  <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50">
                    <img
                      src={url}
                      alt={label}
                      referrerPolicy="no-referrer"
                      className="aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                      loading="lazy"
                    />
                  </div>
                  <p className="mt-1 text-xs text-zinc-400 group-hover:text-zinc-600 transition-colors text-center">
                    {label}
                  </p>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {run.source_url && (
        <a
          href={run.source_url}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block text-xs text-zinc-500 hover:text-zinc-700 transition-colors underline underline-offset-2"
        >
          View product page
        </a>
      )}
    </div>
  );
}
