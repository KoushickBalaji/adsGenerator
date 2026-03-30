export type ProductForPrompt = {
  product_title: string;
  product_description: string;
  product_category: string;
};

export type GeminiKlingPromptRequest = {
  model: string;
  generationConfig: Record<string, unknown>;
  systemPrompt: string;
  userMessage: string;
  imageRefs: string[];
};

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_GENERATION_CONFIG = {
  maxOutputTokens: 1024,
  temperature: 0.7,
  thinkingConfig: { thinkingBudget: 0 },
} as const;

export function buildGeminiKlingPromptRequest(
  product: ProductForPrompt,
  imageCount: number
): GeminiKlingPromptRequest {
  const imageRefs = Array.from(
    { length: Math.min(imageCount, 3) },
    (_, i) => `<<<image_${i + 1}>>>`
  );
  const imageRefStr = imageRefs.join(", ");

  const elementTokenLine =
    "- <<<element_1>>> = the brand ambassador (a real person who will appear in the video)";
  const ambassadorRuleLine = "- You MUST use <<<element_1>>> at least once.";
  const storyboardAmbassadorLine =
    "- Use <<<element_1>>> naturally in the story (not \"presenting\" the jewellery).";
  const goodExampleShot1 =
    "Shot 1 (0-5s): Medium tracking shot of <<<element_1>>> in a cozy everyday moment; the same ring is simply worn (refs: <<<image_1>>>, <<<image_2>>>), and her ring hand stays clearly visible in-frame above any props as she makes a small natural gesture.";
  const goodExampleShot2 =
    "Shot 2 (5-10s): Medium-close lifestyle shot with gentle shallow depth of field; the same ring continues naturally (ref: <<<image_3>>>), and the shot ends on a calm, clean composition with a little negative space (do not mention text/logos).";

  const systemPrompt = `You write Kling AI video prompts for a luxury jewellery ad featuring a human subject (brand ambassador).

You MUST use these special reference tokens in your output - they map to real images/people in the video:
${elementTokenLine}
- ${imageRefs.map((ref, i) => `${ref} = product photo angle ${i + 1}`).join("\n- ")}

MANDATORY:
${ambassadorRuleLine}
- You MUST use EVERY available image token: ${imageRefStr}. Each token is a different view of the SAME piece (different angles/poses) - use them as continuity anchors. NEVER imply the jewellery changes across tokens or between shots.
- Avoid wording that makes the tokens sound like different rings. DO NOT write phrases like "ring from <<<image_1>>> and <<<image_2>>>" or "details matching <<<image_3>>>". Prefer: "the same ring (refs: ${imageRefStr})". Use ONLY the tokens that exist in this request.
- The ambassador wears ONLY the referenced jewellery piece. If it is a ring: show exactly ONE ring on ONE finger (no stacked bands, no extra rings on other fingers). Avoid adding any other jewellery (bracelets, watches, necklaces, earrings).
- NEVER use the product's name or brand name. Avoid other proper nouns (people/places). Refer to the jewellery only through the image tokens or generic descriptions like "the ring", "the necklace", etc.

BRAND TONE (for this demo): "love in the little things" - warm, intimate, lightly nostalgic romcom feel; premium but relatable (avoid high-society opulence).

KLING MULTI-SHOT STORYBOARD (STRICT OUTPUT FORMAT):
- Output EXACTLY two lines (no extra text before/after), formatted exactly like:
  Shot 1 (0-5s): ...
  Shot 2 (5-10s): ...
- Total runtime ~10s, 1:1 (square).
${storyboardAmbassadorLine}
- Each shot MUST include at least one image token, and all tokens must appear at least once across the two lines.
- Keep the jewellery integrated: show it worn in everyday action, not a product display. Avoid "hero shot" language.
- Each shot should include one small, natural micro-action that keeps the ring hand readable (e.g., holding a mug handle, brushing hair back, turning a page, adjusting a sleeve).
- Keep the ambassador visible in both shots (at least face/upper body); avoid cutaways that show only a hand/ring.
- End Shot 2 on a calm lifestyle composition with a little negative space for an end card (do not mention text/logos), but keep the ambassador present (no product-only shot).
- Keep each shot to 1-2 sentences; avoid adding extra cuts within a shot.

CREATIVE DIRECTION:
- Pick two real-life settings (one per shot): home, commute, cafe, bookstore, balcony at dusk, casual dinner.
- Describe camera work and lighting for each shot (tracking, gentle push-in; warm natural light; realistic metal reflections) without calling attention to "product focus".
- Include environmental texture: fabric movement, steam, wind in hair, ambient reflections.
- If props are present (cups/plates/books), keep the ring hand unobstructed: the hand must be clearly visible in-frame above or beside props (no hiding behind dishware).

DO NOT:
- Mention text overlays, voiceover, music, logos, titles, or sound
- Use extreme macro or standalone product shots (no isolated hand-only frames)
- Depict multiple rings / stacked rings / extra jewellery not referenced
- Write generic luxury cliches ("glamorous gala", "red carpet", "shimmering under lights")
- Use markdown, quotes, or explanations - output ONLY the raw prompt

GOOD EXAMPLE (assume 3 product images):
${goodExampleShot1}
${goodExampleShot2}`;

  const userMessage = `Write a Kling video prompt for:
Product: ${product.product_title}
Category: ${product.product_category}
Description: ${product.product_description}

The ambassador is <<<element_1>>>. The product images are: ${imageRefStr}.
You MUST use every single one of these tokens in your prompt.

Output EXACTLY two storyboard lines in this exact format:
Shot 1 (0-5s): ...
Shot 2 (5-10s): ...
(~10s total, 1:1).`;

  return {
    model: GEMINI_MODEL,
    generationConfig: { ...GEMINI_GENERATION_CONFIG },
    systemPrompt,
    userMessage,
    imageRefs,
  };
}

export async function generateKlingPromptWithGemini(
  product: ProductForPrompt,
  imageCount: number
): Promise<{ prompt: string; request: GeminiKlingPromptRequest }> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const request = buildGeminiKlingPromptRequest(product, imageCount);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: request.systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: request.userMessage }],
          },
        ],
        generationConfig: request.generationConfig,
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

  const prompt = String(text).trim();

  // Safety check: if Gemini somehow omitted the required tokens, fail loudly
  if (!prompt.includes("<<<element_1>>>")) {
    throw new Error(`Generated prompt missing <<<element_1>>>: "${prompt}"`);
  }
  const missingImageTokens = request.imageRefs.filter((ref) => !prompt.includes(ref));
  if (missingImageTokens.length > 0) {
    throw new Error(
      `Generated prompt missing required image token(s) ${missingImageTokens.join(", ")}: "${prompt}"`
    );
  }
  const hasShot1 = /^\s*(?:-\s*)?Shot 1 \(0-5s\):/m.test(prompt);
  const hasShot2 = /^\s*(?:-\s*)?Shot 2 \(5-10s\):/m.test(prompt);
  if (!hasShot1 || !hasShot2) {
    throw new Error(
      `Generated prompt missing required Shot 1/Shot 2 storyboard labels: "${prompt}"`
    );
  }

  return { prompt, request };
}
