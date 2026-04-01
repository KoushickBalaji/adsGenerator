export type ProductForPrompt = {
  product_title: string;
  product_description: string;
  product_category: string;
  // Optional: when present, we can pass the actual product photos to Gemini (multimodal)
  // so it can better understand the jewellery design.
  input_images?: string[];
};

type GeminiImageContext = {
  label: string;
  url: string;
  status: "included" | "failed";
  mime_type?: string;
  error?: string;
};

type JewelleryKind =
  | "ring"
  | "necklace"
  | "pendant"
  | "earrings"
  | "bracelet"
  | "bangle"
  | "chain"
  | "mangalsutra"
  | "jewellery";

type JewellerySpec = {
  kind: JewelleryKind;
  noun: string; // e.g. "ring", "necklace", "earrings"
  shot1WornText: string; // must include all image refs
  shot2WornText: string; // no image refs
  visibilityAnchor: string; // what must stay visible (hand/neckline/ears/wrist)
  placement: Record<string, unknown>;
  framingHint: string;
  exampleActionShot1: string;
  exampleActionShot2: string;
  visibilityRules: string[];
  propObstructionExample: string;
};

function getJewellerySpec(
  categoryRaw: string,
  imageRefStr: string
): JewellerySpec {
  const category = (categoryRaw || "").trim().toLowerCase();

  let kind: JewelleryKind = "jewellery";
  if (["ring", "rings"].includes(category)) kind = "ring";
  else if (["necklace", "necklaces"].includes(category)) kind = "necklace";
  else if (["pendant", "pendants"].includes(category)) kind = "pendant";
  else if (["earring", "earrings"].includes(category)) kind = "earrings";
  else if (["bracelet", "bracelets"].includes(category)) kind = "bracelet";
  else if (["bangle", "bangles"].includes(category)) kind = "bangle";
  else if (["chain", "chains"].includes(category)) kind = "chain";
  else if (["mangalsutra", "mangalsutras"].includes(category)) kind = "mangalsutra";

  const noun =
    kind === "earrings"
      ? "earrings"
      : kind === "jewellery"
        ? "jewellery piece"
        : kind;

  const shot1WornText = `wearing the ${noun} shown in (refs: ${imageRefStr})`;
  const shot2WornText = `the same ${noun}`;

  switch (kind) {
    case "ring":
      return {
        kind,
        noun,
        shot1WornText,
        shot2WornText,
        visibilityAnchor: "ring hand (one finger)",
        placement: { hand: "right", finger: "ring" },
        framingHint:
          "face-centered medium shot; ring hand stays in-frame near desk/body, never reaching toward the lens",
        exampleActionShot1:
          "she reviews a slide deck on a laptop and makes a quick note with her ring hand—functional movement, no posing toward camera",
        exampleActionShot2:
          "she leads a meeting holding a slim presentation clicker; her ring hand gestures naturally close to her body while she speaks",
        visibilityRules: [
          "show exactly one ring on one finger",
          "no stacked bands or extra rings",
          "no deliberate showcasing (do not hold the ring finger up toward the camera)",
          "keep the ring visible in natural movement; do not hide it behind large props",
        ],
        propObstructionExample:
          "keep the ring hand in-frame near notebook/keyboard level; avoid mugs/cups fully covering the ring",
      };

    case "necklace":
    case "pendant":
    case "chain":
    case "mangalsutra":
      return {
        kind,
        noun,
        shot1WornText,
        shot2WornText,
        visibilityAnchor: "neckline/collarbone (jewellery centered and unobstructed)",
        placement: { area: "neckline/collarbone", centered: true },
        framingHint:
          "face-centered medium shot; neckline/collarbone stays visible as a secondary detail (not framed like a product shot)",
        exampleActionShot1:
          "she adjusts a blazer lapel while picking up her laptop bag; the jewellery remains naturally visible at the neckline",
        exampleActionShot2:
          "she steps out of an elevator and checks her schedule on her phone; hair and fabric stay off her neckline so the jewellery remains visible",
        visibilityRules: [
          `show exactly one ${noun}; no extra jewellery`,
          "keep neckline/collarbone unobstructed (no scarf/high collar covering it)",
          "no deliberate showcasing (do not touch/pose the jewellery toward camera)",
        ],
        propObstructionExample:
          "avoid scarves/high collars and keep hair off the neckline so the jewellery stays visible",
      };

    case "earrings":
      return {
        kind,
        noun,
        shot1WornText,
        shot2WornText,
        visibilityAnchor: "both ears (hair tucked back)",
        placement: { ears: "both", hair: "tucked behind ears" },
        framingHint:
          "face-centered medium shot; both ears stay visible as a secondary detail (avoid posed hair-tuck 'showing' gestures)",
        exampleActionShot1:
          "she listens in a meeting and turns slightly to respond; hair stays tucked enough that both earrings remain visible",
        exampleActionShot2:
          "she walks through an office corridor, hair moving naturally but not covering the earrings",
        visibilityRules: [
          "show exactly one pair of earrings; no extra jewellery",
          "keep both ears visible; avoid hair covering the earrings",
          "no deliberate showcasing (no exaggerated hair-tuck toward the camera)",
        ],
        propObstructionExample:
          "avoid angles/hair that hide one ear; keep both earrings visible in-frame",
      };

    case "bracelet":
    case "bangle":
      return {
        kind,
        noun,
        shot1WornText,
        shot2WornText,
        visibilityAnchor: "one wrist/forearm (unobstructed)",
        placement: { wrist: "right" },
        framingHint:
          "face-centered medium shot; wrist/forearm stays in frame as a secondary detail (not pushed toward lens)",
        exampleActionShot1:
          "she types on a laptop and reaches for a notebook; the jewellery on her wrist stays naturally visible",
        exampleActionShot2:
          "she rests her forearm on the table during a meeting, wrist visible and unobstructed",
        visibilityRules: [
          `show exactly one ${noun} on one wrist; no extra jewellery`,
          "keep the wrist unobstructed (no cuffs covering it)",
          "no deliberate showcasing (do not angle the wrist toward the camera)",
        ],
        propObstructionExample:
          "keep the wrist above or beside props; avoid sleeves covering the jewellery",
      };

    default:
      return {
        kind,
        noun,
        shot1WornText,
        shot2WornText,
        visibilityAnchor: "the jewellery area (clearly visible and unobstructed)",
        placement: { area: "clearly visible" },
        framingHint: "face + upper body + jewellery clearly visible",
        exampleActionShot1:
          "she makes a small natural gesture that keeps the jewellery clearly visible",
        exampleActionShot2:
          "she settles into a calm pose, keeping the jewellery clearly visible in frame",
        visibilityRules: [
          "show exactly one referenced jewellery piece; no extra jewellery",
          "keep the jewellery unobstructed and in-frame for the full shot",
        ],
        propObstructionExample:
          "do not crop or block the jewellery with props, hair, or fabric",
      };
  }
}

export type GeminiKlingPromptRequest = {
  model: string;
  generationConfig: Record<string, unknown>;
  systemPrompt: string;
  userMessage: string;
  imageRefs: string[];
  productImageUrls: string[];
  geminiImageContext: GeminiImageContext[];
  jewellery: JewellerySpec;
};

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_GENERATION_CONFIG = {
  maxOutputTokens: 1024,
  temperature: 0.7,
  thinkingConfig: { thinkingBudget: 0 },
} as const;

// Kling Omni-Video prompt limit (server-side validation)
// Kling returns: "prompt: size must be between 0 and 2500"
const KLING_PROMPT_MAX_CHARS = 2500;
// Keep a buffer so we don't hover around the edge.
const KLING_PROMPT_TARGET_MAX_CHARS = 2300;

export function buildGeminiKlingPromptRequest(
  product: ProductForPrompt,
  imageCount: number
): GeminiKlingPromptRequest {
  const productImageUrls = Array.isArray(product.input_images)
    ? product.input_images.filter((u) => typeof u === "string")
    : [];

  const imageRefs = Array.from(
    { length: Math.min(imageCount, 3) },
    (_, i) => `<<<image_${i + 1}>>>`
  );
  const imageRefStr = imageRefs.join(", ");
  const jewellery = getJewellerySpec(product.product_category, imageRefStr);

  const elementTokenLine =
    "- <<<element_1>>> = the brand ambassador (a real person who will appear in the video)";
  const ambassadorRuleLine = "- You MUST use <<<element_1>>> at least once.";
  const storyboardAmbassadorLine =
    "- Use <<<element_1>>> naturally in the story (not \"presenting\" the jewellery).";
  const goodExampleShot1 = `Shot 1 (0-5s): ${JSON.stringify({
    ambassador: "<<<element_1>>>",
    scene: {
      setting: "bright home office, rehearsing a presentation with a laptop and notes",
      time_of_day: "early morning",
      mood: "calm, focused, quietly confident",
    },
    wardrobe: {
      top: "fitted ivory knit top",
      bottom: "tailored charcoal trousers",
      layer: "lightweight blazer",
      colors: ["ivory", "charcoal"],
    },
    jewellery: {
      worn_text: jewellery.shot1WornText,
      type: jewellery.kind,
      count: 1,
      placement: jewellery.placement,
      no_other_jewellery: true,
    },
    camera: {
      shot: "medium close-up",
      movement: "gentle push-in",
      framing: jewellery.framingHint,
    },
    action: jewellery.exampleActionShot1,
    visibility_rules: jewellery.visibilityRules,
    lighting: "soft natural window light with realistic metal reflections",
    composition:
      "clean, premium lifestyle framing that prioritizes her face/story; jewellery stays secondary",
  })}`;
  const goodExampleShot2 = `Shot 2 (5-10s): ${JSON.stringify({
    ambassador: "<<<element_1>>>",
    continuity: {
      same_outfit_as_shot_1: true,
      same_jewellery_as_shot_1: true,
    },
    scene: {
      setting: "glass-walled meeting room, mid-morning",
      mood: "composed, quietly powerful, warmly human",
    },
    jewellery: {
      worn_text: jewellery.shot2WornText,
      type: jewellery.kind,
      count: 1,
      placement: jewellery.placement,
      no_other_jewellery: true,
    },
    camera: {
      shot: "medium-close lifestyle",
      movement: "slow push-in",
      depth_of_field: "shallow but keeps face + jewellery visible",
    },
    action: jewellery.exampleActionShot2,
    visibility_rules: [
      ...jewellery.visibilityRules,
      `keep ${jewellery.visibilityAnchor} visible for the full shot`,
    ],
    lighting: "clean, flattering office light with gentle reflections",
    composition:
      "serene framing with a little negative space for an end card (do not mention text/logos)",
  })}`;

  const systemPrompt = `You write Kling AI video prompts for a luxury jewellery ad featuring a human subject (brand ambassador).

You MUST use these special reference tokens in your output - they map to real images/people in the video:
${elementTokenLine}
- ${imageRefs.map((ref, i) => `${ref} = product photo angle ${i + 1}`).join("\n- ")}

MANDATORY:
${ambassadorRuleLine}
- You MUST use EVERY available image token: ${imageRefStr}. Each token is a different view of the SAME piece (different angles/poses) - use them as continuity anchors. NEVER imply the jewellery changes across tokens or between shots.
- Avoid wording that makes the tokens sound like different jewellery pieces. DO NOT write phrases like "from <<<image_1>>> and <<<image_2>>>" or "details matching <<<image_3>>>".
- BEST PRACTICE: define the jewellery ONCE using ALL image tokens together, e.g. "${jewellery.shot1WornText}". After that, refer only to "${jewellery.shot2WornText}" (no new ref tokens in later mentions).
- The ambassador wears ONLY the referenced jewellery piece. Show exactly ONE referenced piece (count = 1) and avoid any other jewellery (no extra rings, necklaces, earrings, bracelets, watches).
- Visibility anchor for this category: keep ${jewellery.visibilityAnchor} visible as a secondary detail in BOTH shots (never posed or pushed toward the lens).
- NEVER use the product's name or brand name. Avoid other proper nouns (people/places). Refer to the jewellery only through the image tokens or generic descriptions like "the ring", "the necklace", etc.

BRAND TONE (for this demo): "love in the little things" - warm, intimate, lightly nostalgic romcom feel; premium but relatable (avoid high-society opulence).

CHARACTER & STORY (MODERN, SUCCESSFUL WOMAN):
- Portray <<<element_1>>> as a modern, successful professional: confident, composed, quietly powerful.
- Prefer day-to-day high-stakes moments that feel real (not glamorous): preparing a boardroom presentation, leading a meeting, stepping out of an elevator, commuting to a big pitch, reviewing a slide deck on a laptop.
- Use subtle success cues (laptop, notebook, presentation clicker, glass-walled meeting room, office lobby) without turning it into a corporate stereotype.
- The jewellery must feel like part of her, not the point: keep it present/visible, but NEVER posed or deliberately shown to the camera.

WARDROBE (MODERN CASUAL):
- Describe the ambassador's modern casual outfit in Shot 1 (top + bottom + 1-2 color cues). Keep it premium, comfortable, and everyday.
- Keep the SAME outfit across BOTH shots (no wardrobe change).
- Aim for variety across generations: choose one of these wardrobe directions each time:
  - linen shirt + high-waisted jeans
  - knit top + midi skirt
  - casual blazer + fitted tee + trousers
  - simple midi dress + light cardigan
  - cotton poplin blouse + wide-leg pants
- Avoid traditional/ceremonial attire (saree, lehenga, heavy wedding wear) and avoid adding accessories/jewellery beyond the referenced piece.

KLING MULTI-SHOT STORYBOARD (JSON STRUCTURE):
- Write a TWO-SHOT storyboard for ~10s total, 1:1 (square).
- Include BOTH shot headings exactly as:
  Shot 1 (0-5s): ...
  Shot 2 (5-10s): ...
- After each heading, output a SINGLE valid JSON object (double quotes, no trailing commas, no comments).
- The JSON can be multi-line, but it must be valid JSON.
- Do NOT wrap the output in Markdown/code fences. Output ONLY the raw storyboard text.
- Keep the output compact: total output must be <= ${KLING_PROMPT_TARGET_MAX_CHARS} characters (Kling hard limit is ${KLING_PROMPT_MAX_CHARS}). Minify JSON (no extra whitespace) and keep string values short.
- In Shot 1 JSON, include a jewellery field like:
  "jewellery": { "worn_text": "${jewellery.shot1WornText}", ... }
- In Shot 2 JSON, set "jewellery.worn_text" to exactly "${jewellery.shot2WornText}" and DO NOT include any image ref tokens in Shot 2.
${storyboardAmbassadorLine}
- Use ALL image tokens at least once in the overall prompt. Prefer to include ALL tokens together in Shot 1 when first defining the jewellery. In Shot 2, refer to "${jewellery.shot2WornText}" without introducing new ref tokens.
- Keep the jewellery integrated: show it worn in everyday action, not a product display. Avoid "hero shot" language.
- Anti-showcase rule: avoid any gesture that looks like "presenting" the jewellery (no hand held up toward the lens, no turning fingers toward camera, no deliberate showcasing). Keep the camera primarily on her face/story; the jewellery is a secondary detail.
- Each shot should include one small, natural micro-action that keeps ${jewellery.visibilityAnchor} readable WITHOUT feeling like a product display (e.g., taking notes during a meeting; neckline unobstructed while adjusting a blazer; hair staying off ears during conversation; wrist visible while typing).
- Keep the ambassador visible in both shots (at least face/upper body); avoid cutaways that show only hands or jewellery.
- End Shot 2 on a calm lifestyle composition with a little negative space for an end card (do not mention text/logos), but keep the ambassador present (no product-only shot).
- Add more scene detail than a minimal prompt (cinematic but realistic). Avoid adding extra cuts within a shot.

CREATIVE DIRECTION:
- Pick two real-life settings (one per shot). Prefer: modern office, boardroom, elevator, office lobby, commute, cafe between meetings, home office before a presentation, balcony at dusk after a win.
- Describe camera work and lighting for each shot (tracking, gentle push-in; warm natural light; realistic metal reflections) without calling attention to "product focus".
- Include environmental texture: fabric movement, steam, wind in hair, ambient reflections.
- If props are present (cups/plates/books), keep the jewellery unobstructed: ${jewellery.propObstructionExample}.

DO NOT:
- Mention text overlays, voiceover, music, logos, titles, or sound
- Use extreme macro or standalone product shots (no isolated hand-only frames)
- Depict multiple rings / stacked rings / extra jewellery not referenced
- Use "showcase" language or camera directions that explicitly present the jewellery to the viewer (no "showing the ring to camera", no "revealing the jewellery", no "focus entirely on the piece")
- Write generic luxury cliches ("glamorous gala", "red carpet", "shimmering under lights")
- Use markdown/code fences or explanations - output ONLY the raw prompt

GOOD EXAMPLE (uses all available image tokens):
${goodExampleShot1}
${goodExampleShot2}`;

  const userMessage = `Write a Kling video prompt for:
Product: ${product.product_title}
Category: ${product.product_category}
Description: ${product.product_description}

The ambassador is <<<element_1>>>. The product images are: ${imageRefStr}.
You MUST use every single one of these tokens in your prompt.
In Shot 1 JSON, set jewellery.worn_text to exactly: "${jewellery.shot1WornText}".
In Shot 2 JSON, set jewellery.worn_text to exactly: "${jewellery.shot2WornText}" (do not include any ${imageRefStr} tokens in Shot 2).
Story: portray <<<element_1>>> as a modern, successful woman in her day-to-day life. Include at least one high-stakes-but-real moment (e.g., prepping/leading a presentation, important meeting, commute to a big pitch). The jewellery must be incidental—never deliberately shown to the camera.
Wardrobe: modern casual. Explicitly describe the outfit in Shot 1 and keep the same outfit in Shot 2.

Output a TWO-SHOT storyboard using these headings, with ONE JSON object after each heading:
Shot 1 (0-5s): ...
Shot 2 (5-10s): ...
(~10s total, 1:1). Keep the TOTAL OUTPUT under ${KLING_PROMPT_TARGET_MAX_CHARS} characters (Kling hard limit is ${KLING_PROMPT_MAX_CHARS}). The JSON should include keys like scene, wardrobe, jewellery, camera, action, visibility_rules, lighting, composition. Do not add extra shots.`;

  return {
    model: GEMINI_MODEL,
    generationConfig: { ...GEMINI_GENERATION_CONFIG },
    systemPrompt,
    userMessage,
    imageRefs,
    productImageUrls,
    geminiImageContext: [],
    jewellery,
  };
}

function toBase64(bytes: Uint8Array): string {
  // Avoid spread on large arrays; build a binary string in chunks.
  const chunkSize = 0x8000; // 32KB
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function imageUrlToGeminiInlineDataPart(
  url: string
): Promise<{ inline_data: { mime_type: string; data: string } } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        // BlueStone CDN is public, but a realistic UA helps avoid edge-case blocking.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = await res.arrayBuffer();
    const base64 = toBase64(new Uint8Array(buffer));
    return { inline_data: { mime_type: contentType, data: base64 } };
  } catch {
    return null;
  }
}

export async function generateKlingPromptWithGemini(
  product: ProductForPrompt,
  imageCount: number
): Promise<{
  prompt: string;
  request: GeminiKlingPromptRequest;
  usageMetadata?: unknown;
}> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const request = buildGeminiKlingPromptRequest(product, imageCount);

  // Build product image parts once so we can retry without refetching images.
  const referenceParts: Array<Record<string, unknown>> = [];
  const geminiImageContext: GeminiImageContext[] = [];

  if (request.productImageUrls.length > 0) {
    referenceParts.push({
      text:
        "Reference product photos (use these to understand the jewellery design; do not mention URLs).",
    });

    for (let i = 0; i < request.productImageUrls.length; i++) {
      const url = request.productImageUrls[i];
      const label = request.imageRefs[i] ?? `additional_image_${i + 1}`;
      const part = await imageUrlToGeminiInlineDataPart(url);
      if (part) {
        referenceParts.push({ text: `Reference photo for ${label}:` });
        referenceParts.push(part as unknown as Record<string, unknown>);
        geminiImageContext.push({
          label,
          url,
          status: "included",
          mime_type: part.inline_data.mime_type,
        });
      } else {
        geminiImageContext.push({
          label,
          url,
          status: "failed",
          error: "Image fetch/encode failed",
        });
      }
    }
  }

  request.geminiImageContext = geminiImageContext;

  async function callGeminiOnce(
    userMessage: string,
    generationConfig: Record<string, unknown>
  ): Promise<{ prompt: string; usageMetadata?: unknown }> {
    const userParts: Array<Record<string, unknown>> = [
      { text: userMessage },
      ...referenceParts,
    ];

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
              parts: userParts,
            },
          ],
          generationConfig,
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

    return { prompt: String(text).trim(), usageMetadata: data?.usageMetadata };
  }

  let usageMetadata: unknown | undefined;
  let prompt: string;

  ({ prompt, usageMetadata } = await callGeminiOnce(
    request.userMessage,
    request.generationConfig
  ));

  // If we exceed Kling's prompt size limit, retry once with a tighter output budget.
  if (prompt.length > KLING_PROMPT_MAX_CHARS) {
    const retryMessage =
      `${request.userMessage}\n\n` +
      `IMPORTANT: Rewrite more compactly so the TOTAL OUTPUT is <= ${KLING_PROMPT_TARGET_MAX_CHARS} characters. ` +
      `Keep the same two shot headings and exactly one JSON object per shot. ` +
      `Keep jewellery.worn_text values EXACTLY as instructed. ` +
      `Remove non-essential words/fields and keep strings short. Minify JSON (no extra whitespace).`;

    const retryConfig = {
      ...request.generationConfig,
      maxOutputTokens: 512,
      temperature: 0.6,
    };

    ({ prompt, usageMetadata } = await callGeminiOnce(retryMessage, retryConfig));
  }

  if (prompt.length > KLING_PROMPT_MAX_CHARS) {
    throw new Error(
      `Generated prompt too long for Kling (${prompt.length} chars; must be <= ${KLING_PROMPT_MAX_CHARS}).`
    );
  }

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

  const requiredShot1WornText = request.jewellery.shot1WornText;
  if (!prompt.includes(requiredShot1WornText)) {
    throw new Error(
      `Generated prompt missing required jewellery definition in Shot 1 (expected: "${requiredShot1WornText}"): "${prompt}"`
    );
  }

  // Enforce the "define refs once" rule: image tokens must not appear after Shot 2 starts.
  const shot2Re = /^\s*(?:-\s*)?Shot 2 \(5-10s\):/m;
  const shot2Match = shot2Re.exec(prompt);
  if (shot2Match?.index != null) {
    const shot2Text = prompt.slice(shot2Match.index);
    const imageTokensInShot2 = request.imageRefs.filter((ref) =>
      shot2Text.includes(ref)
    );
    if (imageTokensInShot2.length > 0) {
      throw new Error(
        `Generated prompt incorrectly includes image token(s) in Shot 2 (${imageTokensInShot2.join(", ")}). Shot 2 must refer only to "${request.jewellery.shot2WornText}".`
      );
    }
    const expectedShot2 = request.jewellery.shot2WornText;
    if (!new RegExp(escapeRegExp(expectedShot2), "i").test(shot2Text)) {
      throw new Error(
        `Generated prompt missing required "${expectedShot2}" wording in Shot 2: "${prompt}"`
      );
    }
  }

  return { prompt, request, usageMetadata };
}
