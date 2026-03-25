import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { scrapeProduct } from "../_shared/scraper.ts";
import {
  createMultiElementsVideo,
  createImageToVideo,
  getRandomElement,
} from "../_shared/kling.ts";

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

    // 1. Scrape product data
    const product = await scrapeProduct(url);

    // 2. Fetch a random element (brand ambassador) from Kling library
    const element = await getRandomElement();
    console.log(
      "Selected element:",
      element ? `${element.name} (${element.id})` : "none — falling back to image-to-video"
    );

    // 3. Generate prompt (element-aware if we have one)
    const prompt = await generatePrompt(product, !!element);

    // 4. Insert DB row
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

    // 5. Call Kling API — multi-elements if we have an element, else basic image-to-video
    const webhookUrl = Deno.env.get("SUPABASE_URL")
      ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/kling-webhook`
      : undefined;

    let klingRes;

    if (element) {
      // Multi-elements: product image + brand ambassador element
      klingRes = await createMultiElementsVideo({
        model_name: "kling-v3-0",
        prompt,
        image_0: product.input_images[0], // product as first frame reference
        element_1: element.id, // brand ambassador
        duration: "5",
        aspect_ratio: "16:9",
        mode: "std",
        callback_url: webhookUrl,
      });
    } else {
      // Fallback: basic image-to-video (no elements available)
      klingRes = await createImageToVideo({
        image: product.input_images[0],
        image_tail: product.input_images[1] || undefined,
        prompt,
        duration: "5",
        aspect_ratio: "16:9",
        cfg_scale: 0.5,
        callback_url: webhookUrl,
      });
    }

    // 6. Update row with provider job ID
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

async function generatePrompt(
  product: {
    product_title: string;
    product_description: string;
    product_category: string;
  },
  hasElement: boolean
): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  // Adjust the system prompt based on whether we have a brand ambassador element
  const elementInstructions = hasElement
    ? `The video will feature a brand ambassador (referenced as @element_1) showcasing the jewellery.
Include natural interactions between the person and the jewellery — the ambassador should be elegantly presenting, wearing, or admiring the piece.
Reference the ambassador as @element_1 in the prompt.
Reference the product image as @image_0 in the prompt.`
    : `The video focuses purely on the jewellery piece itself — no people.`;

  const systemPrompt = `You are a video ad prompt writer for a luxury jewellery brand. Given product details, write a single Kling video generation prompt (2-3 sentences). Always include:
- Premium studio lighting with soft reflections
- Slow cinematic camera motion (pan, orbit, or gentle zoom)
- A clean, premium background (dark velvet, marble, or gradient)
- Preserve the exact product design — no modifications
${elementInstructions}
Keep the prompt under 200 words. Do not include any text overlays or voiceover directions.
Output only the prompt text, nothing else.`;

  const userMessage = `Product: ${product.product_title}\nCategory: ${product.product_category}\nDescription: ${product.product_description}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userMessage }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.7,
        },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No prompt generated");

  return text.trim();
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
