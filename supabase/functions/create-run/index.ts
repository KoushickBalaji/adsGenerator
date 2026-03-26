import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { scrapeProduct } from "../_shared/scraper.ts";
import {
  createMultiElementsVideo,
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

    // Step 1: Scrape product data
    const product = await scrapeProduct(url);
    console.log(`[step 1] Scraped: "${product.product_title}", ${product.input_images.length} images`);

    // Step 2: Fetch a random brand ambassador element — MANDATORY, no fallback
    const element = await getRandomElement();
    if (!element) {
      throw new Error("No brand ambassador elements found in Kling account. Upload elements first.");
    }
    console.log(`[step 2] Ambassador: ${element.name} (${element.id})`);

    // Step 3: Generate prompt — always includes @element_1 + @image_0
    const prompt = await generatePrompt(product, product.input_images.length);
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

    // Step 5: Call Kling multi-elements API
    const webhookUrl = Deno.env.get("SUPABASE_URL")
      ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/kling-webhook`
      : undefined;

    const imgs = product.input_images;
    const klingRes = await createMultiElementsVideo({
      model_name: "kling-v3-0",
      prompt,
      image_0: imgs[0],
      image_1: imgs[1] || undefined,
      image_2: imgs[2] || undefined,
      element_1: element.id,
      duration: "5",
      aspect_ratio: "16:9",
      mode: "std",
      callback_url: webhookUrl,
    });

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
  imageCount: number
): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  // Build image reference list
  const imageRefs = Array.from({ length: Math.min(imageCount, 3) }, (_, i) => `@image_${i}`);
  const imageRefStr = imageRefs.join(", ");

  const systemPrompt = `You write Kling AI video prompts for luxury jewellery ads featuring a brand ambassador.

You MUST use these special reference tokens in your output — they map to real images/people in the video:
- @element_1 = the brand ambassador (a real person who will appear in the video)
- ${imageRefs.map((ref, i) => `${ref} = product photo angle ${i + 1}`).join("\n- ")}

RULES:
1. Your prompt MUST contain @element_1 at least once — she is the main subject.
2. Your prompt MUST contain @image_0 at least once — this is the jewellery product.
3. @element_1 should be WEARING or PRESENTING the ${product.product_category} shown in ${imageRefStr}.
4. Describe cinematic camera motion (slow orbit, gentle zoom, tracking shot).
5. Describe premium lighting (studio lights, soft reflections, warm highlights on metal/gems).
6. Use a luxury setting (dark studio, marble surface, elegant interior).
7. Do NOT mention text overlays, voiceover, music, or sound effects.
8. Output ONLY the raw prompt text — no markdown, no quotes, no explanations.
9. 2-4 sentences, under 200 words.

EXAMPLES:
"@element_1 elegantly presents @image_0, a stunning diamond ring, turning her hand slowly under warm studio lights. The camera orbits gently as light catches each facet, creating soft prismatic reflections against a dark velvet backdrop."

"Close-up of @element_1 wearing @image_0, a delicate gold necklace, as she turns gracefully in soft studio lighting. The camera pulls back slowly to reveal the full pendant design, with warm highlights dancing across the polished metal."`;

  const userMessage = `Write a Kling video prompt for:
Product: ${product.product_title}
Category: ${product.product_category}
Description: ${product.product_description}

Your output MUST include @element_1 (the ambassador) and @image_0 (the product). No exceptions.`;

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
          thinkingConfig: { thinkingBudget: 0 },
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
  if (!text) throw new Error("No prompt generated by Gemini");

  const prompt = text.trim();

  // Safety check: if Gemini somehow omitted the required tokens, fail loudly
  if (!prompt.includes("@element_1")) {
    throw new Error(`Generated prompt missing @element_1: "${prompt}"`);
  }
  if (!prompt.includes("@image_0")) {
    throw new Error(`Generated prompt missing @image_0: "${prompt}"`);
  }

  return prompt;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
