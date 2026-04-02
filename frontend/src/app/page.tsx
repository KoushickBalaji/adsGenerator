"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase, type VideoRun } from "@/lib/supabase";
import { UrlInput } from "@/components/url-input";
import { ProgressCard } from "@/components/progress-card";
import { HistoryList } from "@/components/history-list";

export default function Home() {
  const [runs, setRuns] = useState<VideoRun[]>([]);
  const [activeRun, setActiveRun] = useState<VideoRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  // Load history on mount
  useEffect(() => {
    loadHistory();
  }, []);

  // Subscribe to realtime updates on active run
  useEffect(() => {
    if (!activeRun || activeRun.status === "completed" || activeRun.status === "failed") {
      return;
    }

    const channel = supabase
      .channel(`run-${activeRun.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "video_runs",
          filter: `id=eq.${activeRun.id}`,
        },
        (payload) => {
          const updated = payload.new as VideoRun;
          setActiveRun(updated);
          setRuns((prev) =>
            prev.map((r) => (r.id === updated.id ? updated : r))
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeRun?.id, activeRun?.status]);

  // Auto-poll every 15s when a run is processing (webhook fallback)
  useEffect(() => {
    if (!activeRun || (activeRun.status !== "processing" && activeRun.status !== "queued")) {
      return;
    }

    const poll = async () => {
      try {
        await supabase.functions.invoke("refresh-run", {
          body: { runId: activeRun.id },
        });

        const { data } = await supabase
          .from("video_runs")
          .select("*")
          .eq("id", activeRun.id)
          .single();

        if (data) {
          const updated = data as VideoRun;
          setActiveRun(updated);
          setRuns((prev) =>
            prev.map((r) => (r.id === updated.id ? updated : r))
          );
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
  }, [activeRun?.id, activeRun?.status]);

  async function loadHistory() {
    const { data } = await supabase
      .from("video_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);

    if (data) setRuns(data as VideoRun[]);
  }

  async function handleGenerate(url: string) {
    setError("");
    setStarting(true);

    const nowIso = new Date().toISOString();
    const optimisticRunId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // Optimistically add the run immediately so the UI reflects "in progress"
    // without waiting for the Edge Function to finish all upstream calls.
    const optimisticRun: VideoRun = {
      id: optimisticRunId,
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
        body: { url, runId: optimisticRunId },
      });

      if (res.error) {
        const serverMessage = await readEdgeFunctionError(res.response);
        const fallbackMessage =
          res.error.message === "Edge Function returned a non-2xx status code"
            ? "Something unexpected happened. Please try again."
            : res.error.message;
        throw new Error(
          serverMessage || fallbackMessage || "Failed to start generation"
        );
      }

      const { runId } = res.data as { runId?: string };
      const effectiveRunId = runId || optimisticRunId;

      // Fetch the created run
      const { data: run } = await supabase
        .from("video_runs")
        .select("*")
        .eq("id", effectiveRunId)
        .single();

      if (run) {
        const videoRun = run as VideoRun;
        setRuns((prev) => {
          // Replace optimistic entry (if any) and avoid duplicates
          const withoutOptimistic = prev.filter(
            (r) => r.id !== optimisticRunId && r.id !== videoRun.id
          );
          return [videoRun, ...withoutOptimistic];
        });
        setActiveRun((prev) => (prev?.id === optimisticRunId ? videoRun : prev));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      // Network-level failures get a friendly message; backend errors are already friendly
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
              ? { ...r, status: "failed", error_message: friendly, updated_at: new Date().toISOString() }
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
              ? { ...r, status: "failed", error_message: friendly, updated_at: new Date().toISOString() }
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
    if (!activeRun) return;

    try {
      await supabase.functions.invoke("refresh-run", {
        body: { runId: activeRun.id },
      });

      // Re-fetch the run
      const { data } = await supabase
        .from("video_runs")
        .select("*")
        .eq("id", activeRun.id)
        .single();

      if (data) {
        const updated = data as VideoRun;
        setActiveRun(updated);
        setRuns((prev) =>
          prev.map((r) => (r.id === updated.id ? updated : r))
        );
      }
    } catch {
      // Silently fail — user can try again
    }
  }, [activeRun]);

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
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">
            BlueStone Video Generator
          </h1>
          <span className="text-xs text-zinc-500">Demo</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* Input */}
        <section className="mb-8">
          <UrlInput onSubmit={handleGenerate} disabled={starting} />
          {error && (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
              <svg className="mt-0.5 w-5 h-5 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm text-red-300">{error}</p>
              </div>
              <button
                onClick={() => setError("")}
                className="text-red-400/60 hover:text-red-300 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </section>

        <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
          {/* Active run / main area */}
          <section className="order-1 lg:order-2">
            {activeRun ? (
              <ProgressCard run={activeRun} onRefresh={handleRefresh} />
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center">
                <p className="text-zinc-500">
                  Paste a BlueStone product URL to generate a video ad
                </p>
              </div>
            )}
          </section>

          {/* History sidebar */}
          <aside className="order-2 lg:order-1">
            <h2 className="mb-3 text-sm font-medium text-zinc-400">
              History
            </h2>
            <HistoryList
              runs={runs}
              onSelect={handleSelectRun}
              selectedId={activeRun?.id ?? null}
            />
          </aside>
        </div>
      </main>
    </div>
  );
}
