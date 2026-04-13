"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase, type VideoRun } from "@/lib/supabase";
import { UrlInput } from "@/components/url-input";
import { ProgressCard, ReferencePanel } from "@/components/progress-card";
import { HistoryList } from "@/components/history-list";

type Props = {
  companySlug: string;
  initialUrl?: string;
  autostart?: boolean;
};

function normalizeCompanySlug(input: string): string {
  return (input || "").trim().toLowerCase();
}

function formatCompanyLabel(slug: string): string {
  const cleaned = (slug || "").trim();
  if (!cleaned) return "Unknown";
  return cleaned
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((s) => s.slice(0, 1).toUpperCase() + s.slice(1))
    .join(" ");
}

export default function DemoClient({ companySlug, initialUrl, autostart }: Props) {
  const normalizedCompanySlug = normalizeCompanySlug(companySlug);
  const companyLabel = formatCompanyLabel(normalizedCompanySlug);

  const [runs, setRuns] = useState<VideoRun[]>([]);
  const [activeRun, setActiveRun] = useState<VideoRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [showDisclaimer, setShowDisclaimer] = useState(!autostart);
  const autostartFired = useRef(false);

  const activeRunId = activeRun?.id ?? null;
  const activeRunStatus = activeRun?.status ?? null;

  const loadHistory = useCallback(async () => {
    if (!normalizedCompanySlug) return;

    const { data } = await supabase
      .from("video_runs")
      .select("*")
      .eq("company_slug", normalizedCompanySlug)
      .order("created_at", { ascending: false })
      .limit(20);

    if (data) setRuns(data as VideoRun[]);
  }, [normalizedCompanySlug]);

  // Load history on mount and when company changes
  useEffect(() => {
    setRuns([]);
    setActiveRun(null);
    loadHistory();
  }, [loadHistory]);

  // Auto-start generation when redirected from the landing page with a URL
  useEffect(() => {
    if (autostart && initialUrl && !autostartFired.current) {
      autostartFired.current = true;
      handleGenerate(initialUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart, initialUrl]);

  // Subscribe to realtime updates on active run
  useEffect(() => {
    if (
      !activeRunId ||
      activeRunStatus === "completed" ||
      activeRunStatus === "failed"
    ) {
      return;
    }

    const channel = supabase
      .channel(`run-${activeRunId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "video_runs",
          filter: `id=eq.${activeRunId}`,
        },
        (payload) => {
          const updated = payload.new as VideoRun;
          setActiveRun(updated);
          setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeRunId, activeRunStatus]);

  // Auto-poll every 15s when a run is processing (webhook fallback)
  useEffect(() => {
    if (
      !activeRunId ||
      (activeRunStatus !== "processing" && activeRunStatus !== "queued")
    ) {
      return;
    }

    const poll = async () => {
      try {
        await supabase.functions.invoke("refresh-run", {
          body: {
            runId: activeRunId,
            companySlug: normalizedCompanySlug,
          },
        });

        const { data } = await supabase
          .from("video_runs")
          .select("*")
          .eq("id", activeRunId)
          .eq("company_slug", normalizedCompanySlug)
          .single();

        if (data) {
          const updated = data as VideoRun;
          setActiveRun(updated);
          setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        }
      } catch {
        // Silent - will retry on next interval
      }
    };

    // Start polling after 30s (give webhook a chance first), then every 15s
    const initialDelay = setTimeout(() => {
      poll();
      intervalRef = setInterval(poll, 15000);
    }, 30000);

    let intervalRef: ReturnType<typeof setInterval>;

    return () => {
      clearTimeout(initialDelay);
      if (intervalRef) clearInterval(intervalRef);
    };
  }, [
    activeRunId,
    activeRunStatus,
    normalizedCompanySlug,
  ]);

  async function handleGenerate(url: string) {
    setError("");
    setStarting(true);

    const nowIso = new Date().toISOString();
    const optimisticRunId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const optimisticRun: VideoRun = {
      id: optimisticRunId,
      company_slug: normalizedCompanySlug,
      source_url: url,
      product_title: null,
      product_category: null,
      status: "processing",
      provider: "kling",
      provider_job_id: null,
      input_images: [],
      prompt: null,
      output_video_url: null,
      thumbnail_url: null,
      error_message: null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    setActiveRun(optimisticRun);
    setRuns((prev) => [optimisticRun, ...prev]);

    try {
      const res = await supabase.functions.invoke("create-run", {
        body: {
          url,
          runId: optimisticRunId,
          companySlug: normalizedCompanySlug,
        },
      });

      if (res.error) {
        const serverMessage = await readEdgeFunctionError(res.response);
        const fallbackMessage =
          res.error.message === "Edge Function returned a non-2xx status code"
            ? "Something unexpected happened. Please try again."
            : res.error.message;
        throw new Error(serverMessage || fallbackMessage || "Failed to start generation");
      }

      const { runId } = res.data as { runId?: string };
      const effectiveRunId = runId || optimisticRunId;

      const { data: run } = await supabase
        .from("video_runs")
        .select("*")
        .eq("id", effectiveRunId)
        .eq("company_slug", normalizedCompanySlug)
        .single();

      if (run) {
        const videoRun = run as VideoRun;
        setRuns((prev) => {
          const withoutOptimistic = prev.filter(
            (r) => r.id !== optimisticRunId && r.id !== videoRun.id
          );
          return [videoRun, ...withoutOptimistic];
        });
        setActiveRun((prev) => (prev?.id === optimisticRunId ? videoRun : prev));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (
        msg.includes("Failed to fetch") ||
        msg.includes("NetworkError") ||
        msg.includes("CORS") ||
        msg.includes("Relay Error invoking the Edge Function") ||
        msg.includes("Failed to send a request to the Edge Function")
      ) {
        const friendly =
          "Unable to reach the server. Please check your connection and try again.";
        setError(friendly);
        setRuns((prev) =>
          prev.map((r) =>
            r.id === optimisticRunId
              ? {
                  ...r,
                  status: "failed",
                  error_message: friendly,
                  updated_at: new Date().toISOString(),
                }
              : r
          )
        );
        setActiveRun((prev) =>
          prev?.id === optimisticRunId
            ? {
                ...prev,
                status: "failed",
                error_message: friendly,
                updated_at: new Date().toISOString(),
              }
            : prev
        );
      } else {
        const friendly = msg || "Something unexpected happened. Please try again.";
        setError(friendly);
        setRuns((prev) =>
          prev.map((r) =>
            r.id === optimisticRunId
              ? {
                  ...r,
                  status: "failed",
                  error_message: friendly,
                  updated_at: new Date().toISOString(),
                }
              : r
          )
        );
        setActiveRun((prev) =>
          prev?.id === optimisticRunId
            ? {
                ...prev,
                status: "failed",
                error_message: friendly,
                updated_at: new Date().toISOString(),
              }
            : prev
        );
      }
    }

    setStarting(false);
  }

  const handleRefresh = useCallback(async () => {
    if (!activeRunId) return;

    try {
      await supabase.functions.invoke("refresh-run", {
        body: {
          runId: activeRunId,
          companySlug: normalizedCompanySlug,
        },
      });

      const { data } = await supabase
        .from("video_runs")
        .select("*")
        .eq("id", activeRunId)
        .eq("company_slug", normalizedCompanySlug)
        .single();

      if (data) {
        const updated = data as VideoRun;
        setActiveRun(updated);
        setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      }
    } catch {
      // Silently fail — user can try again
    }
  }, [activeRunId, normalizedCompanySlug]);

  function handleSelectRun(run: VideoRun) {
    setActiveRun(run);
  }

  async function readEdgeFunctionError(response?: Response) {
    if (!response) return "";

    const contentType = response.headers.get("content-type") || "";

    try {
      if (contentType.includes("application/json")) {
        const json = (await response.json()) as unknown;
        const msg =
          (json as { error?: unknown; message?: unknown })?.error ??
          (json as { error?: unknown; message?: unknown })?.message;

        return typeof msg === "string" ? msg : "";
      }

      return await response.text();
    } catch {
      return "";
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {showDisclaimer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 max-w-lg rounded-2xl border border-zinc-200 bg-white p-8 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <svg
                className="w-6 h-6 text-blue-500 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z"
                />
              </svg>
              <h2 className="text-lg font-semibold text-zinc-900">Important Notice</h2>
            </div>
            <div className="space-y-3 text-sm text-zinc-500 leading-relaxed">
              <p>
                This is a <span className="text-zinc-800 font-medium">technology demo</span>, intended to showcase the capabilities of the AI video generation technology.
              </p>
              <p>
                The likeness of the on-screen people are{" "}
                <span className="text-zinc-800 font-medium"> only for demonstration purposes</span>.
              </p>
              <p>
                Generated videos are <span className="text-zinc-800 font-medium">not for commercial use</span>.
              </p>
            </div>
            <button
              onClick={() => setShowDisclaimer(false)}
              className="mt-6 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-2">
        <section className="mx-auto w-full max-w-4xl mb-3 flex-shrink-0">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-zinc-900">Video Demo</h1>
              <p className="text-xs text-zinc-400">Company: {companyLabel}</p>
            </div>
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-[11px] font-medium tracking-wide text-zinc-500">
              Shared demo environment
            </span>
          </div>

          <UrlInput
            onSubmit={handleGenerate}
            disabled={starting}
            placeholder="https://www.example.com/product/..."
            helperText={`Paste a ${companyLabel} product URL to generate a short video ad.`}
            initialValue={initialUrl}
          />

          {error && (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <svg
                className="mt-0.5 w-5 h-5 text-red-500 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                />
              </svg>
              <div className="flex-1">
                <p className="text-sm text-red-600">{error}</p>
              </div>
              <button
                onClick={() => setError("")}
                className="text-red-400 hover:text-red-600 transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          )}
        </section>

        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[2fr_3fr_2fr]">
          <aside className="order-2 lg:order-1 min-h-0 overflow-y-auto">
            <h2 className="mb-3 text-sm font-medium text-zinc-500">History</h2>
            <HistoryList
              runs={runs}
              onSelect={handleSelectRun}
              selectedId={activeRunId}
            />
          </aside>

          <section className="order-1 lg:order-2 min-h-0 overflow-hidden">
            {activeRun ? (
              <ProgressCard run={activeRun} onRefresh={handleRefresh} />
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-300 p-12 text-center">
                <p className="text-zinc-400">Paste a product URL to generate a video ad</p>
              </div>
            )}
          </section>

          <aside className="order-3 min-h-0 overflow-hidden">
            {activeRun && <ReferencePanel run={activeRun} />}
          </aside>
        </div>
      </main>
    </div>
  );
}
