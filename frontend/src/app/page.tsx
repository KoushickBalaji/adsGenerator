"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase, type VideoRun } from "@/lib/supabase";
import { UrlInput } from "@/components/url-input";
import { ProgressCard } from "@/components/progress-card";
import { HistoryList } from "@/components/history-list";

export default function Home() {
  const [runs, setRuns] = useState<VideoRun[]>([]);
  const [activeRun, setActiveRun] = useState<VideoRun | null>(null);
  const [generating, setGenerating] = useState(false);
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
          if (updated.status === "completed" || updated.status === "failed") {
            setGenerating(false);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
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
    setGenerating(true);

    try {
      const res = await supabase.functions.invoke("create-run", {
        body: { url },
      });

      if (res.error) {
        throw new Error(res.error.message || "Failed to start generation");
      }

      const { runId } = res.data;

      // Fetch the created run
      const { data: run } = await supabase
        .from("video_runs")
        .select("*")
        .eq("id", runId)
        .single();

      if (run) {
        const videoRun = run as VideoRun;
        setActiveRun(videoRun);
        setRuns((prev) => [videoRun, ...prev]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setGenerating(false);
    }
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
          <UrlInput onSubmit={handleGenerate} disabled={generating} />
          {error && (
            <p className="mt-3 text-sm text-red-400">{error}</p>
          )}
        </section>

        <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
          {/* Active run / main area */}
          <section>
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
          <aside>
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
