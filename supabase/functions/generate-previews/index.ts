import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { getCompanyConfig, HttpError } from "../_shared/companyConfig.ts";
import { getCompanyPromptProfileOverrides } from "../_shared/companyPromptProfile.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type OccasionPreset =
  | "auto"
  | "casual"
  | "partywear"
  | "marriage"
  | "workwear"
  | "festive";

type PreviewAspectRatio = "1:1" | "16:9" | "9:16";

function normalizeCompanySlug(input: unknown): string {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

function isOccasionPreset(value: unknown): value is OccasionPreset {
  return (
    value === "auto" ||
    value === "casual" ||
    value === "partywear" ||
    value === "marriage" ||
    value === "workwear" ||
    value === "festive"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePreviewAspectRatio(value: unknown): PreviewAspectRatio {
  const v = typeof value === "string" ? value.trim() : "";
  if (v === "16:9" || v === "9:16" || v === "1:1") return v;
  return "1:1";
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v : String(v)))
    .map((v) => v.trim())
    .filter(Boolean);
}

function stripKlingTokens(text: string): string {
  return String(text || "")
    .replace(/<<<[^>]+>>>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonAfterHeading(
  prompt: string,
  headingRe: RegExp
): { jsonText: string; json: Record<string, unknown> } | null {
  const match = headingRe.exec(prompt);
  if (!match) return null;

  const startFrom = match.index + match[0].length;
  const braceStart = prompt.indexOf("{", startFrom);
  if (braceStart < 0) return null;

  let i = braceStart;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; i < prompt.length; i++) {
    const ch = prompt[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonText = prompt.slice(braceStart, i + 1);
        try {
          const parsed = JSON.parse(jsonText);
          if (
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            return { jsonText, json: parsed as Record<string, unknown> };
          }
          return null;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function getNestedString(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" && cur.trim() ? cur.trim() : null;
}

function renderShotStillPrompt(opts: {
  shot: Record<string, unknown> | null;
  productCategory: string | null;
  occasion: OccasionPreset;
  aspectRatio: PreviewAspectRatio;
  shotLabel: "Shot 1" | "Shot 2";
}): string {
  const category = (opts.productCategory || "jewellery").trim().toLowerCase();
  const occasion = opts.occasion;

  const occasionDefaults = (() => {
    switch (occasion) {
      case "workwear":
        return {
          setting: "glass-walled meeting room or modern office lobby",
          wardrobe: "business professional blazer and tailored trousers (non-branded)",
          mood: "calm, focused, quietly confident",
          timeOfDay: "mid-morning",
        };
      case "marriage":
        return {
          setting: "warm-lit getting-ready space or wedding venue hallway (guest vibe)",
          wardrobe: "festive traditional outfit (saree/lehenga style), tasteful and non-revealing (non-branded)",
          mood: "warm, celebratory, elegant, premium",
          timeOfDay: "late afternoon",
        };
      case "partywear":
        return {
          setting: "mirror-ready moment before going out or upscale lobby at night",
          wardrobe: "premium partywear/evening outfit, tasteful and non-revealing (non-branded)",
          mood: "glamorous, warm, confident, premium",
          timeOfDay: "evening",
        };
      case "festive":
        return {
          setting: "festive home gathering with warm ambient decor",
          wardrobe: "festive traditional/smart outfit, tasteful and non-revealing (non-branded)",
          mood: "warm, joyful, premium, elegant",
          timeOfDay: "early evening",
        };
      case "casual":
        return {
          setting: "sunlit cafe by a window or bright apartment hallway",
          wardrobe: "premium casual day dress or smart casual outfit, tasteful and non-revealing (non-branded)",
          mood: "effortless, warm, premium, natural",
          timeOfDay: "late afternoon",
        };
      case "auto":
      default:
        return {
          setting: null,
          wardrobe: null,
          mood: null,
          timeOfDay: null,
        };
    }
  })();

  const sceneSetting = getNestedString(opts.shot, ["scene", "setting"]);
  const sceneMood = getNestedString(opts.shot, ["scene", "mood"]);
  const timeOfDay = getNestedString(opts.shot, ["scene", "time_of_day"]);
  const wardrobe = getNestedString(opts.shot, ["wardrobe", "outfit"]);
  const action = getNestedString(opts.shot, ["action"]);
  const composition = getNestedString(opts.shot, ["composition"]);
  const lighting = getNestedString(opts.shot, ["lighting"]);
  const camera = getNestedString(opts.shot, ["camera"]);

  const occasionHint =
    occasion === "auto"
      ? ""
      : occasion === "marriage"
        ? "wedding-guest / getting-ready vibe"
        : occasion === "partywear"
          ? "evening party vibe"
          : occasion === "workwear"
            ? "workwear / corporate vibe"
            : occasion === "festive"
              ? "festive celebration vibe"
              : "casual premium vibe";

  const lines: string[] = [];
  const aspectHint =
    opts.aspectRatio === "16:9"
      ? "Landscape 16:9"
      : opts.aspectRatio === "9:16"
        ? "Portrait 9:16"
        : "Square 1:1";
  lines.push(
    `${aspectHint} photorealistic cinematic still frame for a luxury jewellery lifestyle ad (${category}).`
  );
  if (occasionHint) lines.push(`Occasion: ${occasionHint}.`);

  lines.push(`Setting: ${sceneSetting || occasionDefaults.setting || "premium modern lifestyle setting"}.`);
  lines.push(`Time of day: ${timeOfDay || occasionDefaults.timeOfDay || "late afternoon"}.`);
  lines.push(`Mood: ${sceneMood || occasionDefaults.mood || "warm, premium, natural"}.`);
  lines.push(`Wardrobe: ${wardrobe || occasionDefaults.wardrobe || "premium non-branded outfit, tasteful and non-revealing"}.`);
  if (action) lines.push(`Action (frozen moment): ${action}.`);
  if (camera) lines.push(`Camera: ${camera}.`);
  if (lighting) lines.push(`Lighting: ${lighting}.`);
  if (composition) lines.push(`Composition: ${composition}.`);

  lines.push(
    "Jewellery is present but subtle and realistic; no deliberate showcasing; no extra jewellery."
  );
  lines.push(
    "The jewellery design must match the provided product reference image exactly (shape, placement, materials)."
  );
  lines.push("No text, no logos, no brand names, no signage, no watermarks.");
  lines.push("High-end editorial color grading; natural skin tones; premium materials.");

  const combined = stripKlingTokens(lines.join(" "));
  return combined || `${opts.shotLabel} preview image, luxury jewellery lifestyle scene.`;
}

async function imageUrlToInlineDataPart(
  url: string
): Promise<{ inline_data: { mime_type: string; data: string } } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buffer.length; i += 0x8000) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    }
    const base64 = btoa(binary);
    return { inline_data: { mime_type: contentType, data: base64 } };
  } catch {
    return null;
  }
}

async function generateGeminiImage(opts: {
  promptText: string;
  referenceImageUrls?: string[] | null;
  productImageUrls?: string[] | null;
  extraIdentityImagePart?: { inline_data: { mime_type: string; data: string } } | null;
}): Promise<{
  bytes: Uint8Array;
  mimeType: string;
}> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const model =
    (Deno.env.get("GEMINI_IMAGE_MODEL") ?? "").trim() ||
    "gemini-3-pro-image-preview";

  const referenceUrls = ensureStringArray(opts.referenceImageUrls);
  const referenceParts: Array<{ inline_data: { mime_type: string; data: string } }> = [];
  for (const url of referenceUrls) {
    const part = await imageUrlToInlineDataPart(url);
    if (part) referenceParts.push(part);
  }
  const productUrls = ensureStringArray(opts.productImageUrls);
  const productParts: Array<{ inline_data: { mime_type: string; data: string } }> = [];
  for (const url of productUrls) {
    const part = await imageUrlToInlineDataPart(url);
    if (part) productParts.push(part);
  }

  const maxImagesPerPrompt = 14;

  // Prioritize using as many product reference images as possible, while still providing at least
  // one identity anchor when available.
  const primaryIdentityPart =
    referenceParts[0] ?? (opts.extraIdentityImagePart ?? null);
  const secondaryIdentityPart =
    primaryIdentityPart === (opts.extraIdentityImagePart ?? null)
      ? null
      : (opts.extraIdentityImagePart ?? null);
  const extraIdentityParts = referenceParts.slice(primaryIdentityPart ? 1 : 0);

  let remainingSlots = maxImagesPerPrompt;
  const selectedIdentityParts: Array<Record<string, unknown>> = [];
  const selectedProductParts: Array<Record<string, unknown>> = [];

  if (primaryIdentityPart && remainingSlots > 0) {
    selectedIdentityParts.push(primaryIdentityPart as unknown as Record<string, unknown>);
    remainingSlots--;
  }

  for (const part of productParts) {
    if (remainingSlots <= 0) break;
    selectedProductParts.push(part as unknown as Record<string, unknown>);
    remainingSlots--;
  }

  if (secondaryIdentityPart && remainingSlots > 0) {
    selectedIdentityParts.push(secondaryIdentityPart as unknown as Record<string, unknown>);
    remainingSlots--;
  }

  for (const part of extraIdentityParts) {
    if (remainingSlots <= 0) break;
    selectedIdentityParts.push(part as unknown as Record<string, unknown>);
    remainingSlots--;
  }

  const baseParts: Array<Record<string, unknown>> = [{ text: opts.promptText }];

  if (selectedIdentityParts.length > 0) {
    baseParts.push({
      text:
        "Identity reference image(s) (the person in the output MUST match the same face and overall identity):",
    });
    baseParts.push(...selectedIdentityParts);
  }

  if (selectedProductParts.length > 0) {
    baseParts.push({
      text:
        "Product reference image(s) (the jewellery must match this exact design and be worn in the scene):",
    });
    baseParts.push(...selectedProductParts);
  }

  async function callOnce(finalParts: Array<Record<string, unknown>>) {
    return fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: finalParts,
            },
          ],
        }),
      }
    );
  }

  let res = await callOnce(baseParts);
  let text = await res.text();
  if (!res.ok && selectedIdentityParts.length > 0) {
    // Best-effort fallback: retry without identity references (keep product if present).
    const fallbackParts: Array<Record<string, unknown>> = [{ text: opts.promptText }];
    if (selectedProductParts.length > 0) {
      fallbackParts.push({
        text:
          "Product reference image(s) (the jewellery must match this exact design and be worn in the scene):",
      });
      fallbackParts.push(...selectedProductParts);
    }
    res = await callOnce(fallbackParts);
    text = await res.text();
  }

  if (!res.ok) {
    throw new Error(`Gemini image API error ${res.status}: ${text}`);
  }

  const data = JSON.parse(text);
  const responseParts: Array<Record<string, unknown>> =
    data?.candidates?.[0]?.content?.parts ?? [];

  for (const part of responseParts) {
    const inlineData =
      (part.inlineData as Record<string, unknown> | undefined) ??
      (part.inline_data as Record<string, unknown> | undefined);

    if (!inlineData) continue;

    const b64 = inlineData.data;
    if (!isNonEmptyString(b64)) continue;

    const mimeTypeRaw = inlineData.mimeType ?? inlineData.mime_type;
    const mimeType =
      typeof mimeTypeRaw === "string" && mimeTypeRaw.trim()
        ? mimeTypeRaw.trim()
        : "image/png";

    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return { bytes, mimeType };
  }

  throw new Error("Gemini image response missing inlineData");
}

function bytesToInlineDataPart(bytes: Uint8Array, mimeType: string): { inline_data: { mime_type: string; data: string } } {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const base64 = btoa(binary);
  return { inline_data: { mime_type: mimeType, data: base64 } };
}

async function uploadImageToStorage(opts: {
  supabase: ReturnType<typeof getServiceClient>;
  companySlug: string;
  runId: string;
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<string> {
  const safeCompanySlug = String(opts.companySlug || "unknown")
    .trim()
    .toLowerCase();
  const path = `${safeCompanySlug}/${opts.runId}/${opts.filename}`;
  const blob = new Blob([opts.bytes], { type: opts.mimeType });

  const { error } = await opts.supabase.storage
    .from("generated-images")
    .upload(path, blob, { upsert: true, contentType: opts.mimeType });
  if (error) throw error;

  const { data: publicUrl } = opts.supabase.storage
    .from("generated-images")
    .getPublicUrl(path);
  return publicUrl.publicUrl;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      if (!text.trim()) return jsonResponse({ error: "Missing JSON body" }, 400);
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const runId = body.runId;
    const companySlug = normalizeCompanySlug(body.companySlug);
    const aspectRatio = normalizePreviewAspectRatio(body.aspectRatio ?? body.aspect_ratio);
    if (!isNonEmptyString(runId)) return jsonResponse({ error: "Missing runId" }, 400);

    const config = getCompanyConfig(companySlug);
    if (!config) {
      return jsonResponse({ error: "Invalid demo link." }, 404);
    }

    const supabase = getServiceClient();

    const { data: run, error: runError } = await supabase
      .from("video_runs")
      .select(
        "id, company_slug, prompt, occasion, product_category, input_images, scraped_images, preview_images, ambassador_element_id, ambassador_element_name"
      )
      .eq("id", runId)
      .eq("company_slug", config.slug)
      .maybeSingle();

    if (runError || !run) return jsonResponse({ error: "Run not found" }, 404);

    const existing = ensureStringArray((run as Record<string, unknown>).preview_images);
    if (existing.length >= 2) {
      return jsonResponse({ status: "ok", preview_images: existing.slice(0, 2) }, 200);
    }

    const prompt = (run as Record<string, unknown>).prompt;
    if (!isNonEmptyString(prompt)) {
      return jsonResponse({ error: "Prompt not ready" }, 409);
    }

    const occasionRaw = (run as Record<string, unknown>).occasion;
    const occasion: OccasionPreset = isOccasionPreset(occasionRaw) ? occasionRaw : "auto";

    const productCategoryRaw = (run as Record<string, unknown>).product_category;
    const productCategory =
      typeof productCategoryRaw === "string" ? productCategoryRaw : null;

    const scrapedImagesRaw = (run as Record<string, unknown>).scraped_images;
    const inputImagesRaw = (run as Record<string, unknown>).input_images;
    const scrapedImages = ensureStringArray(scrapedImagesRaw);
    const inputImages = ensureStringArray(inputImagesRaw);
    const allProductImages = scrapedImages.length > 0 ? scrapedImages : inputImages;
    const productImageUrls = Array.from(
      new Set(allProductImages.map((u) => String(u).trim()).filter(Boolean))
    );

    const promptProfileOverrides = await getCompanyPromptProfileOverrides(
      supabase,
      config.slug
    );
    const ambassadorReferenceImageUrl =
      typeof promptProfileOverrides?.ambassadorReferenceImageUrl === "string"
        ? promptProfileOverrides.ambassadorReferenceImageUrl.trim()
        : "";

    let elementFrontalUrl = "";
    let elementRefUrls: string[] = [];
    const ambassadorElementIdRaw = (run as Record<string, unknown>).ambassador_element_id;
    const ambassadorElementId =
      typeof ambassadorElementIdRaw === "string" ? ambassadorElementIdRaw.trim() : "";
    const ambassadorElementNameRaw = (run as Record<string, unknown>).ambassador_element_name;
    const ambassadorElementName =
      typeof ambassadorElementNameRaw === "string" ? ambassadorElementNameRaw.trim() : "";

    if (ambassadorElementId) {
      try {
        const { data: asset } = await supabase
          .from("kling_element_assets")
          .select("frontal_url, ref_urls")
          .eq("element_id", ambassadorElementId)
          .maybeSingle();
        if (asset && typeof (asset as any).frontal_url === "string") {
          elementFrontalUrl = String((asset as any).frontal_url).trim();
        }
        if (asset && Array.isArray((asset as any).ref_urls)) {
          elementRefUrls = ensureStringArray((asset as any).ref_urls);
        }
      } catch {
        // ignore: best-effort
      }
    }

    if (!elementFrontalUrl && !ambassadorReferenceImageUrl && ambassadorElementName) {
      // Secondary lookup: by name. Useful when element IDs are present but the mapping
      // was backfilled by name, or when a run stores a name for debugging.
      try {
        const { data: asset } = await supabase
          .from("kling_element_assets")
          .select("frontal_url, ref_urls")
          .eq("element_name", ambassadorElementName)
          .maybeSingle();
        if (asset && typeof (asset as any).frontal_url === "string") {
          elementFrontalUrl = String((asset as any).frontal_url).trim();
        }
        if (asset && Array.isArray((asset as any).ref_urls)) {
          elementRefUrls = ensureStringArray((asset as any).ref_urls);
        }
      } catch {
        // ignore: best-effort
      }
    }

    const variableReferenceUrls = ensureStringArray(
      (promptProfileOverrides?.variables as Record<string, unknown> | undefined)
        ?.ambassador_reference_image_urls ??
        (promptProfileOverrides?.variables as Record<string, unknown> | undefined)
          ?.ambassadorReferenceImageUrls
    );

    const identityReferenceUrls = Array.from(
      new Set(
        [
          ambassadorReferenceImageUrl,
          ...variableReferenceUrls,
          elementFrontalUrl,
          ...elementRefUrls,
        ].filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      )
    ).slice(0, 8);

    if (ambassadorElementId && identityReferenceUrls.length === 0) {
      await supabase
        .from("video_runs")
        .update({
          preview_error:
            "Ambassador reference images are not configured. Set company_prompt_profiles.ambassador_reference_image_url (and optionally variables.ambassador_reference_image_urls) or populate kling_element_assets for the selected element.",
        })
        .eq("id", runId)
        .eq("company_slug", config.slug);
    }

    const shot1 = extractJsonAfterHeading(
      prompt,
      /^\s*(?:-\s*)?Shot 1 \(0-5s\):/m
    );
    const shot2 = extractJsonAfterHeading(
      prompt,
      /^\s*(?:-\s*)?Shot 2 \(5-10s\):/m
    );

    const prompt1 = renderShotStillPrompt({
      shot: shot1?.json ?? null,
      productCategory,
      occasion,
      aspectRatio,
      shotLabel: "Shot 1",
    });
    const prompt2 = renderShotStillPrompt({
      shot: shot2?.json ?? null,
      productCategory,
      occasion,
      aspectRatio,
      shotLabel: "Shot 2",
    });

    let urls: string[] = [];
    try {
      // Gemini image generation supports multiple images per prompt, but has a per-request cap.
      // We spread product angles across Shot 1/2 when there are many images.
      const hasIdentityRefs = identityReferenceUrls.length > 0;
      const shot1ProductCap = hasIdentityRefs ? 13 : 14;
      // Shot 2 always includes the Shot 1 frame as an extra identity anchor.
      const shot2ProductCap = 13;

      const normalizedProductUrls = productImageUrls.filter(Boolean);
      const first = normalizedProductUrls[0] ?? "";

      const shot1Products =
        normalizedProductUrls.length <= shot1ProductCap
          ? normalizedProductUrls
          : normalizedProductUrls.slice(0, shot1ProductCap);

      const remaining = normalizedProductUrls.slice(shot1ProductCap);
      const shot2Products =
        normalizedProductUrls.length <= shot1ProductCap
          ? normalizedProductUrls
          : Array.from(
              new Set(
                [first, ...remaining].filter(Boolean)
              )
            ).slice(0, shot2ProductCap);

      const img1 = await generateGeminiImage({
        promptText: `${prompt1} Ensure the jewellery from the product reference image is visible and consistent.`,
        referenceImageUrls: identityReferenceUrls,
        productImageUrls: shot1Products,
        extraIdentityImagePart: null,
      });

      // Use Shot 1 as an extra identity anchor for Shot 2 so the same ambassador carries across.
      const shot1IdentityPart = bytesToInlineDataPart(img1.bytes, img1.mimeType);

      const img2 = await generateGeminiImage({
        promptText: `${prompt2} Ensure the jewellery from the product reference image is visible and consistent.`,
        referenceImageUrls: identityReferenceUrls,
        productImageUrls: shot2Products,
        extraIdentityImagePart: shot1IdentityPart,
      });

      const url1 = await uploadImageToStorage({
        supabase,
        companySlug: config.slug,
        runId: String(runId),
        filename: "shot1.png",
        bytes: img1.bytes,
        mimeType: img1.mimeType,
      });
      const url2 = await uploadImageToStorage({
        supabase,
        companySlug: config.slug,
        runId: String(runId),
        filename: "shot2.png",
        bytes: img2.bytes,
        mimeType: img2.mimeType,
      });

      urls = [url1, url2];

      await supabase
        .from("video_runs")
        .update({ preview_images: urls, preview_error: null })
        .eq("id", runId)
        .eq("company_slug", config.slug);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase
        .from("video_runs")
        .update({ preview_error: message })
        .eq("id", runId)
        .eq("company_slug", config.slug);
      return jsonResponse({ status: "error", error: "Preview generation failed" }, 200);
    }

    return jsonResponse({ status: "ok", preview_images: urls }, 200);
  } catch (err) {
    console.error("generate-previews error:", err);
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Internal error" },
      500
    );
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
