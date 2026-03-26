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
    const prompt = await generatePrompt(product, !!element, product.input_images.length);

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
      // Multi-elements: up to 3 product images + 1 brand ambassador element
      // Kling allows max 3 images + elements combined
      const imgs = product.input_images;
      klingRes = await createMultiElementsVideo({
        model_name: "kling-v3-0",
        prompt,
        image_0: imgs[0], // main product shot
        image_1: imgs[1] || undefined, // second angle
        image_2: imgs[2] || undefined, // third angle
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
  hasElement: boolean,
  imageCount: number
): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  // Build image reference list
  const imageRefs = Array.from({ length: Math.min(imageCount, 3) }, (_, i) => `@image_${i}`);
  const imageRefStr = imageRefs.join(", ");

  let systemPrompt: string;

  if (hasElement) {
    systemPrompt = `You write Kling AI video prompts for luxury jewellery ads. You MUST use the special reference tokens exactly as shown.

AVAILABLE REFERENCES:
- @element_1 = the brand ambassador (a real person — use them as the main subject)
- ${imageRefs.map((ref, i) => `${ref} = product photo angle ${i + 1}`).join("\n- ")}

RULES:
1. Your prompt MUST contain @element_1 at least once — this is the brand ambassador who wears/presents the jewellery.
2. Your prompt MUST contain @image_0 at least once — this is the product being showcased.
3. The ambassador (@element_1) should be WEARING or PRESENTING the ${product.product_category} shown in ${imageRefStr}.
4. Include cinematic camera motion (slow orbit, gentle zoom, or tracking shot).
5. Include premium lighting (studio lights, soft reflections, warm highlights on metal/gems).
6. Use a luxury setting (dark studio, marble surface, elegant interior, or soft gradient backdrop).
7. Do NOT mention text overlays, voiceover, music, or sound.
8. Output ONLY the prompt — no explanations, no markdown, no quotes.
9. Keep it 2-4 sentences, under 200 words.

EXAMPLES:
- "@element_1 elegantly presents @image_0, a stunning diamond ring, turning her hand slowly under warm studio lights. The camera orbits gently as light catches each facet, creating soft prismatic reflections against a dark velvet backdrop."
- "Close-up of @element_1 wearing @image_0, a delicate gold necklace, as she turns gracefully in soft studio lighting. The camera pulls back slowly to reveal the full pendant design, with warm highlights dancing across the polished metal."`;
  } else {
    systemPrompt = `You write Kling AI video prompts for luxury jewellery product shots. No people — product only.

RULES:
1. Focus entirely on the jewellery piece itself.
2. Include cinematic camera motion (slow orbit, gentle zoom, or tracking shot).
3. Include premium lighting (studio lights, soft reflections, warm highlights on metal/gems).
4. Use a luxury setting (dark velvet, marble, soft gradient).
5. Do NOT mention text overlays, voiceover, music, or sound.
6. Output ONLY the prompt — no explanations, no markdown, no quotes.
7. Keep it 2-3 sentences, under 200 words.`;
  }

  const userMessage = `Write a Kling video prompt for this jewellery product:
Product: ${product.product_title}
Category: ${product.product_category}
Description: ${product.product_description}
${hasElement ? `\nRemember: You MUST include @element_1 (ambassador) and @image_0 (product) in your output.` : ""}`;

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
          maxOutputTokens: 1024,
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 0 }, // disable thinking to avoid eating output tokens
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
