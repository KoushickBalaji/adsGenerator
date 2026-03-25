import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { scrapeProduct } from "../_shared/scraper.ts";
import { createImageToVideo } from "../_shared/kling.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
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
      return jsonResponse({ error: "Only BlueStone URLs are supported" }, 400);
    }

    // 1. Scrape product data
    const product = await scrapeProduct(url);

    // 2. Generate prompt via Claude API
    const prompt = await generatePrompt(product);

    // 3. Insert DB row
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

    // 4. Call Kling API
    const webhookUrl = Deno.env.get("SUPABASE_URL")
      ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/kling-webhook`
      : undefined;

    const klingRes = await createImageToVideo({
      prompt,
      image_list: [
        { url: product.input_images[0], type: "first_frame" },
        ...(product.input_images[1]
          ? [{ url: product.input_images[1], type: "end_frame" as const }]
          : []),
      ],
      duration: 5,
      aspect_ratio: "16:9",
      cfg_scale: 0.5,
      callback_url: webhookUrl,
    });

    // 5. Update row with provider job ID
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
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Internal error" },
      500
    );
  }
});

async function generatePrompt(product: {
  product_title: string;
  product_description: string;
  product_category: string;
}): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: `You are a video ad prompt writer for a luxury jewellery brand. Given product details, write a single Kling image-to-video prompt (2-3 sentences). Always include:
- Premium studio lighting with soft reflections
- Slow cinematic camera motion (pan, orbit, or gentle zoom)
- A clean, premium background (dark velvet, marble, or gradient)
- Preserve the exact product design — no modifications
Keep the prompt under 200 words. Do not include any text overlays or voiceover directions.
Output only the prompt text, nothing else.`,
      messages: [
        {
          role: "user",
          content: `Product: ${product.product_title}\nCategory: ${product.product_category}\nDescription: ${product.product_description}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find(
    (b: { type: string }) => b.type === "text"
  );
  if (!textBlock?.text) throw new Error("No prompt generated");

  return textBlock.text.trim();
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
