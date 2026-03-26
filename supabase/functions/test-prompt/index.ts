import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { scrapeProduct } from "../_shared/scraper.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Fetch an image URL and return it as a base64-encoded data part for Gemini.
 */
async function imageUrlToGeminiPart(
  url: string
): Promise<{ inline_data: { mime_type: string; data: string } } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = await res.arrayBuffer();
    const base64 = btoa(
      String.fromCharCode(...new Uint8Array(buffer))
    );
    return { inline_data: { mime_type: contentType, data: base64 } };
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { url } = await req.json();

    // Step 1: Scrape product
    const product = await scrapeProduct(url);
    const images = product.input_images.slice(0, 3);

    // Step 2: Fetch images as base64 for Gemini vision
    const imageParts = (
      await Promise.all(images.map((imgUrl) => imageUrlToGeminiPart(imgUrl)))
    ).filter(Boolean);

    // Build image label parts so Gemini knows which token maps to which image
    const imageLabels = images
      .map((_, i) => `@image_${i}`)
      .join(", ");

    const systemPrompt = `You are a creative director writing Kling AI video prompts for luxury jewellery ad films.

You will be shown reference images of a jewellery piece. Study them carefully — notice the type of jewellery, the metal color, the stones, and how it looks when worn.

REFERENCE TOKENS (you MUST use these — they map to real assets in the video engine):
- @element_1 = a brand ambassador (real person, will be composited into the video)
- ${images.map((_, i) => `@image_${i} = reference image ${i + 1} of the jewellery piece (shown below)`).join("\n- ")}

CRITICAL RULES:
1. MUST include @element_1 at least once — she is the star of the ad.
2. MUST include at least one @image_N token (${imageLabels}) to anchor the product in the scene.
3. NEVER use the product's name, brand name, or any proper noun. Kling doesn't know product names — using them causes visual hallucinations (e.g. "Lotus Ring" generates an actual lotus). Refer to the piece only as "the ${product.product_category}" or via the @image token.
4. Write a STORYLINE, not a product shot. Think 5-second ad film: the ambassador has a moment, an emotion, a real-life setting. The jewellery is part of her world, not the sole focus.
5. @element_1 should be WEARING the ${product.product_category} naturally — part of her everyday look, not "presenting" or "revealing" it.
6. ONE continuous camera move (tracking, dolly, slow push-in, handheld follow). No cuts.
7. Set a REAL-LIFE scene. Pick from a wide range — everyday moments are powerful:
   - Professional: giving a presentation, typing at a laptop, leading a meeting
   - Active: morning jog, yoga, gym, playing a sport
   - Social: laughing with friends at a café, school pickup, grocery shopping
   - Intimate: reading on the couch, cooking dinner, morning coffee on a balcony
   - Aspirational: rooftop at golden hour, gallery opening, boarding a flight
   The jewellery should feel like something she never takes off — part of every moment.
8. Include subtle motion: hair, fabric, ambient light, natural reflections.
9. Do NOT mention text, voiceover, music, logos, titles, or sound.
10. Output ONLY the raw prompt — no quotes, no markdown, no explanation.
11. 3-5 sentences, 60-120 words.

GOOD EXAMPLES:
"@element_1 stands at the front of a bright conference room, gesturing confidently at a presentation screen. The camera slowly dollies in from the back of the room. Natural daylight from floor-to-ceiling windows catches @image_0 on her wrist as she moves her hand, casting a brief warm reflection on the glass table."

"@element_1 jogs along a tree-lined path in early morning light, her breath visible in the cool air. The camera tracks alongside her in a smooth handheld follow. As she slows to a walk and pushes hair from her face, @image_1 catches a shaft of golden sunlight filtering through the leaves."

"@element_1 sits cross-legged on a living room couch, a paperback open in her lap and a steaming mug beside her. Soft afternoon light drifts through sheer curtains. The camera slowly pushes in as she turns a page — @image_0 on her finger glints quietly in the warm light."

BAD EXAMPLES (DO NOT write like these):
- "A slow orbit around the Solaris Ring on dark velvet" ← product shot, no story, uses product name
- "@element_1 presents @image_0 under studio lights" ← no narrative, catalog feel
- "@element_1 at a glamorous gala wearing @image_0" ← lazy, always defaults to luxury events`;

    // Build multimodal user message: text + images
    const userParts: Array<Record<string, unknown>> = [];

    // Add text instruction first
    userParts.push({
      text: `Here are the reference images of the ${product.product_category}. Study them, then write a Kling video ad prompt.\n\nRemember: @element_1 is the ambassador. ${imageLabels} are the product images shown below — use whichever feels natural. Tell a story.`,
    });

    // Add each image with a label
    for (let i = 0; i < imageParts.length; i++) {
      userParts.push({ text: `\n@image_${i}:` });
      userParts.push(imageParts[i]!);
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: userParts }],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.7,
            thinkingConfig: { thinkingBudget: 4096 },
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const text = await geminiRes.text();
      throw new Error(`Gemini error ${geminiRes.status}: ${text}`);
    }

    const geminiData = await geminiRes.json();
    const generatedPrompt =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    // Validate: must have @element_1 and at least one @image_N
    const hasElement1 = generatedPrompt?.includes("@element_1") ?? false;
    const hasAnyImage =
      /\@image_\d/.test(generatedPrompt || "");

    return json({
      status: "dry_run_complete",
      product: {
        title: product.product_title,
        category: product.product_category,
        image_count: product.input_images.length,
        images: product.input_images,
      },
      prompt: {
        generated: generatedPrompt,
        has_element_1: hasElement1,
        has_image_ref: hasAnyImage,
        valid: hasElement1 && hasAnyImage,
      },
    });
  } catch (err) {
    console.error("test-prompt error:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
