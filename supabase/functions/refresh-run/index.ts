import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { getTaskStatus } from "../_shared/kling.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { runId } = await req.json();

    if (!runId) {
      return jsonResponse({ error: "Missing runId" }, 400);
    }

    const supabase = getServiceClient();

    // Get the run
    const { data: run, error: dbError } = await supabase
      .from("video_runs")
      .select("*")
      .eq("id", runId)
      .single();

    if (dbError || !run) {
      return jsonResponse({ error: "Run not found" }, 404);
    }

    if (!run.provider_job_id) {
      return jsonResponse({ error: "No provider job ID" }, 400);
    }

    if (run.status === "completed" || run.status === "failed") {
      return jsonResponse({ status: run.status });
    }

    // Poll Kling API
    const klingRes = await getTaskStatus(run.provider_job_id);
    const task = klingRes.data;

    let status = run.status;
    let outputVideoUrl: string | null = null;
    let errorMessage: string | null = null;

    if (task.task_status === "succeed") {
      status = "completed";
      const videoUrl = task.task_result?.videos?.[0]?.url;
      if (videoUrl) {
        outputVideoUrl = await uploadToStorage(supabase, run.id, videoUrl);
      }
    } else if (task.task_status === "failed") {
      status = "failed";
      errorMessage = task.task_status_msg || "Generation failed";
    } else if (task.task_status === "processing") {
      status = "processing";
    }

    // Update DB
    const update: Record<string, unknown> = { status };
    if (outputVideoUrl) update.output_video_url = outputVideoUrl;
    if (errorMessage) update.error_message = errorMessage;

    await supabase.from("video_runs").update(update).eq("id", run.id);

    return jsonResponse({ status });
  } catch (err) {
    console.error("refresh-run error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Internal error" },
      500
    );
  }
});

async function uploadToStorage(
  supabase: ReturnType<typeof getServiceClient>,
  runId: string,
  videoUrl: string
): Promise<string> {
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);

    const blob = await res.blob();
    const path = `${runId}.mp4`;

    const { error } = await supabase.storage
      .from("generated-videos")
      .upload(path, blob, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (error) throw error;

    const { data: publicUrl } = supabase.storage
      .from("generated-videos")
      .getPublicUrl(path);

    return publicUrl.publicUrl;
  } catch (err) {
    console.error("Storage upload failed, using provider URL:", err);
    return videoUrl;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
