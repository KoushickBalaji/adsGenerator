import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { scrapeProduct } from "../_shared/scraper.ts";
import {
  createOmniVideo,
  getRandomElement,
  isElementNameEligible,
} from "../_shared/kling.ts";
import { generateKlingPromptWithGemini } from "../_shared/geminiPrompt.ts";
import {
  assertDemoKey,
  assertUrlAllowed,
  getCompanyConfig,
  HttpError,
} from "../_shared/companyConfig.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-demo-key",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const supabase = getServiceClient();
  let insertedRunId: string | null = null;
  let createdProviderJobId: string | null = null;

  try {
    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      if (!text.trim()) {
        return jsonResponse({ error: "Missing JSON body" }, 400);
      }
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const url = body.url;
    const runId = body.runId;
    const companySlug = typeof body.companySlug === "string" ? body.companySlug : "bluestone";

    const config = getCompanyConfig(companySlug);
    if (!config) {
      return jsonResponse({ error: "Invalid demo link." }, 404);
    }

    // Gate early (before any costly work).
    assertDemoKey({ req, config, bodyDemoKey: body.demoKey });

    // Validate URL
    if (!url || typeof url !== "string") {
      return jsonResponse({ error: "Missing url" }, 400);
    }

    assertUrlAllowed(url, config);

    // Step 0: Cleanup stale active runs so they don't permanently block new generations
    // (e.g. if a webhook never arrives or a provider request failed after DB insert).
    const now = Date.now();
    const queuedCutoffIso = new Date(now - 10 * 60 * 1000).toISOString(); // 10 min
    const processingCutoffIso = new Date(now - 45 * 60 * 1000).toISOString(); // 45 min

    await supabase
      .from("video_runs")
      .update({
        status: "failed",
        error_message: "This run timed out. Please try generating again.",
      })
      .eq("status", "queued")
      .lt("created_at", queuedCutoffIso);

    await supabase
      .from("video_runs")
      .update({
        status: "failed",
        error_message: "This run timed out. Please try generating again.",
      })
      .eq("status", "processing")
      .lt("created_at", processingCutoffIso);

    // Step 1: Lifetime credits cap (success = mp4 created + URL recorded on the run)
    const { count: successCount, error: successCountError } = await supabase
      .from("video_runs")
      .select("id", { count: "exact", head: true })
      .eq("company_slug", config.slug)
      .eq("status", "completed")
      .not("output_video_url", "is", null);

    if (successCountError) {
      console.warn("[step 1] Could not check success count:", successCountError);
    } else if ((successCount ?? 0) >= config.limits.maxLifetimeSuccessfulVideos) {
      return jsonResponse(
        { error: "You have run out of demo credits. Reach out to the developer." },
        403
      );
    }

    // Step 2: Optional attempt throttle (protects against repeated failures / link sharing)
    if (typeof config.limits.maxAttemptsPerDay === "number") {
      const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: attemptCount, error: attemptCountError } = await supabase
        .from("video_runs")
        .select("id", { count: "exact", head: true })
        .eq("company_slug", config.slug)
        .gte("created_at", sinceIso);

      if (attemptCountError) {
        console.warn("[step 2] Could not check attempt count:", attemptCountError);
      } else if ((attemptCount ?? 0) >= config.limits.maxAttemptsPerDay) {
        return jsonResponse(
          { error: "Too many attempts for this demo right now. Reach out to the developer." },
          429
        );
      }
    }

    // Step 1: Basic concurrency guard (keep UX simple; no explicit limit in the UI)
    const { count: activeCount, error: countError } = await supabase
      .from("video_runs")
      .select("id", { count: "exact", head: true })
      .eq("company_slug", config.slug)
      .in("status", ["queued", "processing"]);

    if (countError) {
      console.warn("[step 0] Could not check active runs count:", countError);
    } else if ((activeCount ?? 0) >= config.limits.maxConcurrentRuns) {
      return jsonResponse(
        { error: "We're a bit busy right now. Please try again in a few minutes." },
        429
      );
    }

    // Step 2: Insert DB row early so the UI can reflect "in progress" immediately
    // (even while we are still scraping and calling upstream services).
    const insertPayload: Record<string, unknown> = {
      source_url: url,
      status: "processing",
      company_slug: config.slug,
    };
    if (typeof runId === "string" && isUuid(runId)) {
      insertPayload.id = runId;
    }

    const { data: run, error: insertError } = await supabase
      .from("video_runs")
      .insert(insertPayload)
      .select()
      .single();

    if (insertError) throw insertError;
    insertedRunId = run.id;

    // Step 3: Scrape product data
    const product = await scrapeProduct(url, {
      adapter: config.scraper.adapter,
      maxReferenceImages: config.scraper.maxReferenceImages,
    });
    console.log(
      `[step 3] Scraped: "${product.product_title}", ${product.input_images.length} images`
    );

    // Step 4: Fetch a random brand ambassador element - required
    let element: Awaited<ReturnType<typeof getRandomElement>> | null = null;
    let pickedPrefix: string | null = null;

    if (config.kling.ambassador.enabled) {
      const prefixes = config.kling.ambassador.elementPrefixCandidates ?? [];
      if (prefixes.length === 0) {
        throw new Error(
          `No eligible model persona configured for ${config.slug}. prefixes: (empty)`
        );
      }
      pickedPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
      element = await getRandomElement({ namePrefix: pickedPrefix });
      if (!element) {
        throw new Error(
          `No eligible model persona configured for ${config.slug}. prefixes: ${prefixes.join(", ")}`
        );
      }
      // Defensive: should never happen because getRandomElement filters, but keep a hard guardrail.
      if (!isElementNameEligible(element.name, pickedPrefix)) {
        throw new Error(
          `Selected element "${element.name}" is not eligible. Expected name to start with "${pickedPrefix}".`
        );
      }
      console.log(`[step 4] Model persona: ${element.name} (${element.id})`);
    }

    // Step 5: Generate prompt (always includes <<<element_1>>> + <<<image_1>>>...)
    const { prompt, request } = await generateKlingPromptWithGemini(
      product,
      product.input_images.length,
      config.prompt
    );
    console.log(`[step 5] Prompt: ${prompt}`);
    console.log(
      `[step 5] Selected reference angles (first 3): ${(request.productImageUrls || [])
        .slice(0, 3)
        .join(", ")}`
    );

    // Step 6: Update DB row with product + prompt details
    const { error: updateError } = await supabase
      .from("video_runs")
      .update({
        product_title: product.product_title,
        product_category: product.product_category,
        // Persist the ordered references used for this run:
        // - first 3 are used by Kling (video + prompt tokens)
        // - remaining (if any) are prompt-only context
        input_images: request.productImageUrls,
        prompt,
      })
      .eq("id", run.id);

    if (updateError) throw updateError;

    // Step 7: Call Kling Omni-Video API (O-series, e.g. O3)
    const webhookUrl = Deno.env.get("SUPABASE_URL")
      ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/kling-webhook`
      : undefined;

    const imgs = request.productImageUrls;
    console.log(
      `[step 7] Kling model candidates: ${config.kling.modelCandidates.join(", ")}`
    );
    const imageList = imgs.slice(0, 3).map((imageUrl) => ({
      image_url: imageUrl,
    }));

    let klingRes:
      | Awaited<ReturnType<typeof createOmniVideo>>
      | null = null;
    let lastError: unknown = null;

    for (const modelName of config.kling.modelCandidates) {
      try {
        console.log(`[step 7] Trying Kling model: ${modelName}`);
        klingRes = await createOmniVideo({
          model_name: modelName,
          prompt,
          image_list: imageList,
          ...(element ? { element_list: [{ element_id: element.id }] } : {}),
          duration: config.kling.defaults.duration,
          aspect_ratio: config.kling.defaults.aspectRatio,
          mode: config.kling.defaults.mode,
          callback_url: webhookUrl,
        });
        console.log(`[step 7] Using Kling model: ${modelName}`);
        break;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        // Only fall back when Kling explicitly rejects the model name.
        if (msg.toLowerCase().includes("model_name") && msg.toLowerCase().includes("invalid")) {
          console.warn(
            `[step 7] Kling rejected model "${modelName}" as invalid; trying next candidate.`
          );
          continue;
        }
        throw err;
      }
    }

    if (!klingRes) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Kling request failed");
    }

    console.log(`[step 7] Kling task: ${klingRes.data.task_id}`);
    createdProviderJobId = klingRes.data.task_id;

    // Step 8: Update row with provider job ID
    await supabase
      .from("video_runs")
      .update({
        provider_job_id: klingRes.data.task_id,
        status: "processing",
      })
      .eq("id", run.id);

    return jsonResponse({ runId: run.id });
  } catch (err) {
    console.error("create-run error:", err);

    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    const raw = err instanceof Error ? err.message : String(err);
    const friendly = toFriendlyError(raw);

    // If we already created a DB row, mark it failed so it doesn't clog the queue.
    if (insertedRunId) {
      try {
        await supabase
          .from("video_runs")
          .update({
            status: "failed",
            error_message: friendly,
            ...(createdProviderJobId ? { provider_job_id: createdProviderJobId } : {}),
          })
          .eq("id", insertedRunId);
      } catch (updateErr) {
        console.warn("[create-run] Failed to mark run as failed:", updateErr);
      }
    }

    return jsonResponse({ error: friendly }, 500);
  }
});

/** Map raw technical errors to user-friendly messages */
function toFriendlyError(raw: string): string {
  const lower = raw.toLowerCase();

  if (lower.includes("gemini_api_key") || lower.includes("gemini api"))
    return "Our AI service is temporarily unavailable. Please try again in a moment.";

  if (lower.includes("kling_access_key") || lower.includes("kling_secret_key"))
    return "Video generation service is being configured. Please try again shortly.";

  if (lower.includes("no eligible model persona") || lower.includes("no eligible persona"))
    return "No eligible model persona is configured for this demo yet. Reach out to the developer.";

  if (lower.includes("kling elements api"))
    return "We couldn't load the model persona library. Please try again.";

  if (lower.includes("model_name") && lower.includes("invalid"))
    return "Video model configuration is invalid. Please update the model setting and try again.";

  if (lower.includes("prompt: size must be between 0 and 2500") || lower.includes("prompt too long"))
    return "We generated a scene description that's too detailed for the video engine. Please try again.";

  if (lower.includes("kling_model_name not set"))
    return "Video model is not configured yet. Please set KLING_MODEL_NAME and try again.";

  if (lower.includes("generated prompt missing"))
    return "We had trouble crafting the perfect prompt. Please try again - each attempt is unique.";

  if (lower.includes("kling") && (lower.includes("401") || lower.includes("403")))
    return "Video generation service credentials are being refreshed. Please try again shortly.";

  if (lower.includes("kling") && lower.includes("429"))
    return "We're generating too many videos right now. Please wait a moment and try again.";

  if (lower.includes("element id not found"))
    return "We couldn't find the selected model persona in Kling. Please try again.";

  if (lower.includes("kling"))
    return "Video generation service encountered an issue. Please try again.";

  if (lower.includes("scrape") || lower.includes("product"))
    return "We couldn't read that product page. Please check the URL and try again.";

  if (lower.includes("invalid url") || lower.includes("missing url"))
    return "Please enter a valid product URL.";

  // Catch-all - never expose raw internals
  return "Something unexpected happened. Please try again.";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function isUuid(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    input
  );
}
