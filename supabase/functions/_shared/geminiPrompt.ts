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
  sizeCue: string; // short, qualitative scale guidance
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
        sizeCue: "realistic scale; single ring, not chunky/oversized",
        visibilityAnchor: "ring hand (single ring; one hand only)",
        placement: { hand: "right", finger: "ring", other_hand: "bare" },
        framingHint:
          "face-centered medium shot; ring hand stays in-frame near desk/body, never reaching toward the lens; other hand stays natural and ring-free",
        exampleActionShot1:
          "she reviews a slide deck and makes a quick note with her ring hand - practical movement, no posing; the other hand stays relaxed and ring-free",
        exampleActionShot2:
          "she leads a meeting and gestures naturally with her ring hand close to her body while speaking; the other hand remains ring-free",
        visibilityRules: [
          "show exactly one ring total (single hand, single finger only)",
          "no rings on the other hand or on any other fingers",
          "no stacked bands, no duplicate rings",
          "no deliberate showcasing (do not hold the ring finger up toward the camera)",
          "keep the ring visible in natural movement; do not hide it behind large props",
        ],
        propObstructionExample:
          "keep the ring hand in-frame near notebook/keyboard level; avoid symmetrical two-hand poses; avoid mugs/cups fully covering the ring",
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
        sizeCue: "realistic scale; delicate chain, petite pendant; not oversized",
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
        sizeCue: "realistic scale; subtle everyday earrings, not oversized",
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
        sizeCue: "realistic scale; single bracelet/bangle, not chunky",
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
        sizeCue: "realistic scale; subtle, not oversized",
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

// For selecting a small subset of "best" reference angles, keep the model more deterministic.
const GEMINI_IMAGE_SELECTION_CONFIG = {
  maxOutputTokens: 128,
  temperature: 0.2,
  thinkingConfig: { thinkingBudget: 0 },
  responseMimeType: "application/json",
} as const;

// Kling Omni-Video prompt limit (server-side validation)
// Kling returns: "prompt: size must be between 0 and 2500"
const KLING_PROMPT_MAX_CHARS = 2500;
// Keep a buffer so we don't hover around the edge.
const KLING_PROMPT_TARGET_MAX_CHARS = 2300;

// Keep candidate image count small to avoid large request payloads when we pass images as inline_data.
const MAX_PRODUCT_IMAGE_CANDIDATES = 12;

function parseSelectedIndices(
  text: string,
  maxCandidateCount: number
): number[] | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  function normalize(values: unknown): number[] | null {
    const rawArr = Array.isArray(values)
      ? values
      : values && typeof values === "object"
        ? (values as Record<string, unknown>).selected
        : null;
    if (!Array.isArray(rawArr)) return null;

    const out: number[] = [];
    const seen = new Set<number>();
    for (const v of rawArr) {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) continue;
      const idx = Math.trunc(n);
      if (idx < 1 || idx > maxCandidateCount) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
      if (out.length >= 3) break;
    }
    return out.length === 3 ? out.map((n) => n - 1) : null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const normalized = normalize(parsed);
    if (normalized) return normalized;
  } catch {
    // fall through
  }

  // Fallback: extract integers from free-form text like "Selected: 2, 5, 1"
  const matches = trimmed.match(/\d+/g) || [];
  const nums: number[] = [];
  const seen = new Set<number>();
  for (const m of matches) {
    const n = Number(m);
    if (!Number.isFinite(n)) continue;
    const idx = Math.trunc(n);
    if (idx < 1 || idx > maxCandidateCount) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    nums.push(idx);
    if (nums.length >= 3) break;
  }
  return nums.length === 3 ? nums.map((n) => n - 1) : null;
}

async function selectBestThreeImagesWithGemini(opts: {
  apiKey: string;
  model: string;
  candidates: Array<{
    url: string;
    part: { inline_data: { mime_type: string; data: string } };
  }>;
}): Promise<{ selectedIndexes: number[]; usageMetadata?: unknown } | null> {
  const { apiKey, model, candidates } = opts;
  if (candidates.length <= 3) return null;

  const systemPrompt =
    "You are curating reference images for a jewellery video model. " +
    "You will be shown multiple candidate images labeled Candidate 1..N. " +
    "Pick the BEST 3 candidates to represent the product design.\n\n" +
    "CRITERIA (most important first):\n" +
    "- Prefer clean product-only renders (single item on plain background).\n" +
    "- Avoid video thumbnails/posters (play icon, 'VIDEO' label, poster frames).\n" +
    "- Avoid worn/lifestyle shots (hands/models) unless there are no product-only renders.\n" +
    "- Avoid collages or images with multiple jewellery items.\n" +
    "- Choose 3 distinct angles/views.\n\n" +
    "OUTPUT:\n" +
    'Return ONLY valid JSON: {"selected":[i,j,k]} where i/j/k are 1-based candidate numbers.';

  const userParts: Array<Record<string, unknown>> = [
    { text: `Select 3 best candidates out of ${candidates.length}.` },
  ];
  for (let i = 0; i < candidates.length; i++) {
    userParts.push({ text: `Candidate ${i + 1}:` });
    userParts.push(candidates[i].part as unknown as Record<string, unknown>);
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: userParts }],
        generationConfig: { ...GEMINI_IMAGE_SELECTION_CONFIG },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const selectedIndexes = parseSelectedIndices(String(text ?? ""), candidates.length);
  if (!selectedIndexes) return null;
  return { selectedIndexes, usageMetadata: data?.usageMetadata };
}

export function buildGeminiKlingPromptRequest(
  product: ProductForPrompt,
  imageCount: number
): GeminiKlingPromptRequest {
  const productImageUrls = Array.isArray(product.input_images)
    ? product.input_images
        .filter((u) => typeof u === "string")
        .slice(0, MAX_PRODUCT_IMAGE_CANDIDATES)
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
      top: "silk button-down blouse (fully opaque, modest neckline)",
      bottom: "tailored charcoal trousers",
      layer: "structured blazer",
      colors: ["ivory", "charcoal"],
    },
    jewellery: {
      worn_text: jewellery.shot1WornText,
      size_cue: jewellery.sizeCue,
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
- You may receive additional reference photos beyond the ${imageRefStr} tokens. Treat them as extra views of the SAME piece; do not mention or imply differences.
- Avoid wording that makes the tokens sound like different jewellery pieces. DO NOT write phrases like "from <<<image_1>>> and <<<image_2>>>" or "details matching <<<image_3>>>".
- BEST PRACTICE: define the jewellery ONCE using ALL image tokens together, e.g. "${jewellery.shot1WornText}". After that, refer only to "${jewellery.shot2WornText}" (no new ref tokens in later mentions).
- The ambassador wears ONLY the referenced jewellery piece. Show exactly ONE referenced piece (count = 1) and avoid any other jewellery (no extra rings, necklaces, earrings, bracelets, watches).
- If the jewellery is a ring: show exactly ONE ring total. No rings on the other hand or any other fingers.
- Size realism: keep the jewellery at a believable real-world scale based on the reference photos (no oversized statement scaling). In Shot 1 JSON, include a short jewellery.size_cue describing approximate scale (qualitative; keep it short).
- Visibility anchor for this category: keep ${jewellery.visibilityAnchor} visible as a secondary detail in BOTH shots (never posed or pushed toward the lens).
- NEVER use the product's name or brand name. Avoid other proper nouns (people/places). Refer to the jewellery only through the image tokens or generic descriptions like "the ring", "the necklace", etc.

BRAND TONE (for this demo): "love in the little things" - warm, intimate, lightly nostalgic romcom feel; premium but relatable (avoid high-society opulence).

CHARACTER & STORY (MODERN, SUCCESSFUL WOMAN):
- Portray <<<element_1>>> as a modern, successful professional: confident, composed, quietly powerful.
- Prefer day-to-day high-stakes moments that feel real (not glamorous): preparing a boardroom presentation, leading a meeting, stepping out of an elevator, commuting to a big pitch, reviewing a slide deck on a laptop.
- Use subtle success cues (laptop, notebook, presentation clicker, glass-walled meeting room, office lobby) without turning it into a corporate stereotype.
- The jewellery must feel like part of her, not the point: keep it present/visible, but NEVER posed or deliberately shown to the camera.

WARDROBE (BUSINESS PROFESSIONAL):
- Dress code is fully corporate and boardroom-appropriate.
- Describe the ambassador's business-professional outfit in Shot 1 (top + bottom + optional layer + 1-2 color cues).
- Keep the SAME outfit across BOTH shots (no wardrobe change).
- Aim for variety across generations: choose one of these wardrobe directions each time:
  - tailored blazer + silk button-down blouse + trousers
  - monochrome pantsuit + tucked-in blouse
  - structured sheath midi dress + blazer
  - high-neck fine-knit top + blazer + pencil skirt
  - crisp cotton shirt + wide-leg trousers
- Avoid traditional/ceremonial attire (saree, lehenga, heavy wedding wear) and avoid adding accessories/jewellery beyond the referenced piece.
- STRICTLY AVOID: corsets, bralettes, lingerie, crop tops, visible bra, deep cleavage, sheer lace, strapless/off-shoulder looks.

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
In Shot 1 JSON, include jewellery.size_cue as a short, qualitative description of realistic scale based on the reference photos (e.g., "delicate, petite; not oversized").
Story: portray <<<element_1>>> as a modern, successful woman in her day-to-day life. Include at least one high-stakes-but-real moment (e.g., prepping/leading a presentation, important meeting, commute to a big pitch). The jewellery must be incidental - never deliberately shown to the camera.
Wardrobe: business professional (corporate/boardroom). Explicitly describe the outfit in Shot 1 and keep the same outfit in Shot 2. Avoid anything revealing (no corset/lingerie/crop tops).

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

  const candidateUrls = Array.isArray(product.input_images)
    ? product.input_images
        .filter((u) => typeof u === "string")
        .slice(0, MAX_PRODUCT_IMAGE_CANDIDATES)
    : [];

  // Fetch/encode candidate images once so we can:
  // 1) optionally ask Gemini to pick the best 3 reference angles
  // 2) reuse the same inline_data parts for the prompt-generation call (and retry)
  const fetchedCandidates = await Promise.all(
    candidateUrls.map(async (url, originalIndex) => {
      const part = await imageUrlToGeminiInlineDataPart(url);
      return { url, originalIndex, part };
    })
  );
  const partByUrl = new Map(
    fetchedCandidates.map((c) => [c.url, c.part] as const)
  );

  const loadedCandidates = fetchedCandidates
    .filter(
      (c): c is {
        url: string;
        originalIndex: number;
        part: { inline_data: { mime_type: string; data: string } };
      } => Boolean(c.part)
    )
    .sort((a, b) => a.originalIndex - b.originalIndex);

  let selectedUrls: string[] = candidateUrls.slice(0, 3);
  let selectionUsageMetadata: unknown | undefined;

  if (candidateUrls.length > 3 && loadedCandidates.length >= 3) {
    const selectable = loadedCandidates;
    try {
      if (selectable.length > 3) {
        const selection = await selectBestThreeImagesWithGemini({
          apiKey,
          model: GEMINI_MODEL,
          candidates: selectable,
        });
        if (selection) {
          selectionUsageMetadata = selection.usageMetadata;
          selectedUrls = selection.selectedIndexes.map((i) => selectable[i].url);
        } else {
          selectedUrls = selectable.slice(0, 3).map((c) => c.url);
        }
      } else {
        selectedUrls = selectable.slice(0, 3).map((c) => c.url);
      }
    } catch (err) {
      console.warn(
        "[geminiPrompt] Image selection failed; falling back to first 3 candidates.",
        err
      );
      selectedUrls = candidateUrls.slice(0, 3);
    }
  } else if (loadedCandidates.length >= 3) {
    // If we have >=3 loadable candidates, prefer those for the first 3 slots.
    selectedUrls = loadedCandidates.slice(0, 3).map((c) => c.url);
  }

  const selectedSet = new Set(selectedUrls);
  const orderedUrls = [
    ...selectedUrls,
    ...candidateUrls.filter((u) => !selectedSet.has(u)),
  ];

  // Keep the original product object immutable; create a view with ordered images.
  // First 3 URLs = Kling + prompt reference tokens, remainder = prompt-only context.
  const orderedProduct: ProductForPrompt = {
    ...product,
    input_images: orderedUrls,
  };

  const request = buildGeminiKlingPromptRequest(
    orderedProduct,
    orderedUrls.length || imageCount
  );

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
      const part = partByUrl.get(url) ?? (await imageUrlToGeminiInlineDataPart(url));
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
  // Non-breaking: attach selection usage metadata for debugging (test-prompt returns this object)
  (request as unknown as Record<string, unknown>).image_selection_usage_metadata =
    selectionUsageMetadata;

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
