import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { scrapeProduct } from "../_shared/scraper.ts";
import { getRandomElement } from "../_shared/kling.ts";

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

    // Step 1: Scrape
    const product = await scrapeProduct(url);
    console.log(`[step 1] Scraped: "${product.product_title}", ${product.input_images.length} images`);

    // Step 2: Fetch element
    const element = await getRandomElement();
    console.log(`[step 2] Element:`, element ? `${element.name} (${element.id})` : "NONE");

    if (!element) {
      return json({
        error: "No elements found in Kling account",
        step: 2,
        product,
      }, 500);
    }

    // Step 3: Generate prompt
    const imageCount = Math.min(product.input_images.length, 3);
    const imageRefs = Array.from({ length: imageCount }, (_, i) => `@image_${i}`);
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

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.7,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const text = await geminiRes.text();
      throw new Error(`Gemini error ${geminiRes.status}: ${text}`);
    }

    const geminiData = await geminiRes.json();
    const generatedPrompt = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    // Validate
    const hasElement1 = generatedPrompt?.includes("@element_1");
    const hasImage0 = generatedPrompt?.includes("@image_0");

    // STOP HERE — no Kling call, no DB write
    return json({
      status: "dry_run_complete",
      product: {
        title: product.product_title,
        category: product.product_category,
        images: product.input_images,
      },
      element: {
        name: element.name,
        id: element.id,
      },
      prompt: {
        system_instruction: systemPrompt,
        user_message: userMessage,
        generated: generatedPrompt,
        has_element_1: hasElement1,
        has_image_0: hasImage0,
        valid: hasElement1 && hasImage0,
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
