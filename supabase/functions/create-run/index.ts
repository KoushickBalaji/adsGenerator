import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { scrapeProduct } from "../_shared/scraper.ts";
import {
  createOmniVideo,
  getRandomElement,
  BRAND_ELEMENT_NAME_PREFIX,
  isElementNameEligible,
} from "../_shared/kling.ts";
import { generateKlingPromptWithGemini } from "../_shared/geminiPrompt.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // Non-secret config: hardcode the Kling model(s) for this demo.
    // We'll try the preferred model first, then fall back if Kling rejects it as invalid.
    const KLING_MODEL_CANDIDATES = ["kling-v3-omni", "kling-v3"] as const;

    const { url } = await req.json();

    // Validate URL
    if (!url || typeof url !== "string") {
      return jsonResponse({ error: "Missing url" }, 400);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return jsonResponse({ error: "Invalid URL" }, 400);
    }

    if (!parsed.hostname.includes("bluestone.com")) {
      return jsonResponse(
        { error: "Only BlueStone URLs are supported" },
        400
      );
    }

    // Step 1: Scrape product data
    const product = await scrapeProduct(url);
    console.log(`[step 1] Scraped: "${product.product_title}", ${product.input_images.length} images`);

    // Step 2: Fetch a random brand ambassador element - required
    const element = await getRandomElement({
      namePrefix: BRAND_ELEMENT_NAME_PREFIX,
    });
    if (!element) {
      throw new Error(
        `No eligible brand ambassador elements found. Please create a custom Kling element whose name starts with "${BRAND_ELEMENT_NAME_PREFIX}" (e.g. "${BRAND_ELEMENT_NAME_PREFIX}-anya"), then try again.`
      );
    }
    // Defensive: should never happen because getRandomElement filters, but keep a hard guardrail.
    if (!isElementNameEligible(element.name, BRAND_ELEMENT_NAME_PREFIX)) {
      throw new Error(
        `Selected element "${element.name}" is not eligible. Expected name to start with "${BRAND_ELEMENT_NAME_PREFIX}".`
      );
    }
    console.log(`[step 2] Ambassador: ${element.name} (${element.id})`);

    // Step 3: Generate prompt (always includes <<<element_1>>> + <<<image_1>>>...)
    const { prompt } = await generateKlingPromptWithGemini(
      product,
      product.input_images.length
    );
    console.log(`[step 3] Prompt: ${prompt}`);

    // Step 4: Insert DB row
    const supabase = getServiceClient();
    const { data: run, error: dbError } = await supabase
      .from("video_runs")
      .insert({
        source_url: url,
        product_title: product.product_title,
        product_category: product.product_category,
        status: "queued",
        input_images: product.input_images,
        prompt,
      })
      .select()
      .single();

    if (dbError) throw dbError;

    // Step 5: Call Kling Omni-Video API (O-series, e.g. O3)
    const webhookUrl = Deno.env.get("SUPABASE_URL")
      ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/kling-webhook`
      : undefined;

    const imgs = product.input_images;
    console.log(
      `[step 5] Kling model candidates: ${KLING_MODEL_CANDIDATES.join(", ")}`
    );
    const imageList = imgs.slice(0, 3).map((imageUrl) => ({
      image_url: imageUrl,
    }));

    let klingRes:
      | Awaited<ReturnType<typeof createOmniVideo>>
      | null = null;
    let lastError: unknown = null;

    for (const modelName of KLING_MODEL_CANDIDATES) {
      try {
        console.log(`[step 5] Trying Kling model: ${modelName}`);
        klingRes = await createOmniVideo({
          model_name: modelName,
          prompt,
          image_list: imageList,
          element_list: [{ element_id: element.id }],
          duration: "10",
          aspect_ratio: "1:1",
          mode: "pro",
          callback_url: webhookUrl,
        });
        console.log(`[step 5] Using Kling model: ${modelName}`);
        break;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        // Only fall back when Kling explicitly rejects the model name.
        if (msg.toLowerCase().includes("model_name") && msg.toLowerCase().includes("invalid")) {
          console.warn(
            `[step 5] Kling rejected model "${modelName}" as invalid; trying next candidate.`
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

    console.log(`[step 5] Kling task: ${klingRes.data.task_id}`);

    // Step 6: Update row with provider job ID
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
    const raw = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { error: toFriendlyError(raw) },
      500
    );
  }
});

/** Map raw technical errors to user-friendly messages */
function toFriendlyError(raw: string): string {
  const lower = raw.toLowerCase();

  if (lower.includes("gemini_api_key") || lower.includes("gemini api"))
    return "Our AI service is temporarily unavailable. Please try again in a moment.";

  if (lower.includes("kling_access_key") || lower.includes("kling_secret_key"))
    return "Video generation service is being configured. Please try again shortly.";

  if (lower.includes("no eligible brand ambassador") || lower.includes("no brand ambassador"))
    return `No eligible brand ambassador is configured yet. Please create a custom Kling element whose name starts with "${BRAND_ELEMENT_NAME_PREFIX}" and try again.`;

  if (lower.includes("kling elements api"))
    return "We couldn't load the brand ambassador library. Please try again.";

  if (lower.includes("model_name") && lower.includes("invalid"))
    return "Video model configuration is invalid. Please update the model setting and try again.";

  if (lower.includes("kling_model_name not set"))
    return "Video model is not configured yet. Please set KLING_MODEL_NAME and try again.";

  if (lower.includes("generated prompt missing"))
    return "We had trouble crafting the perfect prompt. Please try again - each attempt is unique.";

  if (lower.includes("kling") && (lower.includes("401") || lower.includes("403")))
    return "Video generation service credentials are being refreshed. Please try again shortly.";

  if (lower.includes("kling") && lower.includes("429"))
    return "We're generating too many videos right now. Please wait a moment and try again.";

  if (lower.includes("element id not found"))
    return "We couldn't find the selected brand ambassador in Kling. Please try again.";

  if (lower.includes("kling"))
    return "Video generation service encountered an issue. Please try again.";

  if (lower.includes("scrape") || lower.includes("product"))
    return "We couldn't read that product page. Please check the URL and try again.";

  if (lower.includes("invalid url") || lower.includes("missing url"))
    return "Please enter a valid BlueStone product URL.";

  if (lower.includes("only bluestone"))
    return "This tool works exclusively with BlueStone product URLs.";

  // Catch-all - never expose raw internals
  return "Something unexpected happened. Please try again.";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
