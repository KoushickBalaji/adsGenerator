import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function extractVideoUrl(taskResult: any): string | null {
  const candidates: Array<unknown> = [
    taskResult?.videos?.[0]?.url,
    taskResult?.videos?.[0]?.video_url,
    taskResult?.video_url,
    taskResult?.videoUrl,
    taskResult?.result?.videos?.[0]?.url,
    taskResult?.result?.video_url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // Optional: verify webhook secret
    const secret = Deno.env.get("WEBHOOK_SECRET");
    if (secret) {
      const authHeader = req.headers.get("authorization");
      if (authHeader !== `Bearer ${secret}`) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const payload = await req.json();

    // Kling callback payload contains task_id, task_status, task_result
    const taskId = payload.data?.task_id || payload.task_id;
    const taskStatus = payload.data?.task_status || payload.task_status;
    const taskResult = payload.data?.task_result || payload.task_result;

    if (!taskId) {
      return new Response("Missing task_id", { status: 400 });
    }

    const supabase = getServiceClient();

    // Find the run by provider_job_id
    const { data: run } = await supabase
      .from("video_runs")
      .select("id, company_slug")
      .eq("provider_job_id", taskId)
      .single();

    if (!run) {
      console.warn(`No run found for task_id: ${taskId}`);
      return new Response("OK", { status: 200 });
    }

    // Map Kling status to our status
    let status: string;
    let outputVideoUrl: string | null = null;
    let errorMessage: string | null = null;

    if (taskStatus === "succeed") {
      const videoUrl = extractVideoUrl(taskResult);
      if (videoUrl) {
        status = "completed";
        // Download and upload to Supabase Storage for stable hosting
        outputVideoUrl = await uploadToStorage(
          supabase,
          run.company_slug ?? "unknown",
          run.id,
          videoUrl
        );
      } else {
        status = "failed";
        errorMessage = "Video provider returned success, but no video URL was available.";
      }
    } else if (taskStatus === "failed") {
      status = "failed";
      errorMessage = payload.data?.task_status_msg || "Generation failed";
    } else {
      status = "processing";
    }

    // Update the run
    const update: Record<string, unknown> = { status };
    if (outputVideoUrl) update.output_video_url = outputVideoUrl;
    if (errorMessage) update.error_message = errorMessage;

    await supabase.from("video_runs").update(update).eq("id", run.id);

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("kling-webhook error:", err);
    return new Response("Internal error", { status: 500 });
  }
});

async function uploadToStorage(
  supabase: ReturnType<typeof getServiceClient>,
  companySlug: string,
  runId: string,
  videoUrl: string
): Promise<string> {
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);

    const blob = await res.blob();
    const safeCompanySlug = String(companySlug || "unknown").trim().toLowerCase();
    const path = `${safeCompanySlug}/${runId}.mp4`;

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
    // Fall back to provider URL (may expire)
    return videoUrl;
  }
}
