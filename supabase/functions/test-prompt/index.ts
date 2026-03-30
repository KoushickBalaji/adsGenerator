import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { scrapeProduct } from "../_shared/scraper.ts";
import { generateKlingPromptWithGemini } from "../_shared/geminiPrompt.ts";
import {
  BRAND_ELEMENT_NAME_PREFIX,
  createCustomElement,
  isElementNameEligible,
  listCustomElements,
  listPresetElements,
} from "../_shared/kling.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // Utility mode: list Kling elements visible to the API credentials.
    // Note: production only uses CUSTOM elements whose names start with BRAND_ELEMENT_NAME_PREFIX.
    // GET /functions/v1/test-prompt?mode=elements&kind=custom|preset|all&all=true&pageSize=100&maxPages=20
    const reqUrl = new URL(req.url);
    const mode = reqUrl.searchParams.get("mode");
    if (req.method === "GET" && mode === "elements") {
      const kind = reqUrl.searchParams.get("kind") ?? "all";
      const allPages = reqUrl.searchParams.get("all") === "true";

      const pageNumRaw = reqUrl.searchParams.get("pageNum") ?? "1";
      const pageSizeRaw = reqUrl.searchParams.get("pageSize") ?? "50";
      const pageNum = Math.max(1, Number(pageNumRaw) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(pageSizeRaw) || 50));
      const maxPages = Math.min(
        50,
        Math.max(1, Number(reqUrl.searchParams.get("maxPages") ?? "10") || 10)
      );

      const baseUrl =
        (Deno.env.get("KLING_BASE_URL") ?? "https://api-singapore.klingai.com")
          .replace(/\/+$/, "");

      async function listAllPages(
        which: "custom" | "preset"
      ): Promise<Awaited<ReturnType<typeof listCustomElements>>> {
        const out: Awaited<ReturnType<typeof listCustomElements>> = [];
        for (let page = 1; page <= maxPages; page++) {
          const res =
            which === "custom"
              ? await listCustomElements(page, pageSize)
              : await listPresetElements(page, pageSize);
          out.push(...res);
          if (res.length < pageSize) break;
        }
        return out;
      }

      const custom =
        kind === "custom" || kind === "all"
          ? allPages
            ? await listAllPages("custom")
            : await listCustomElements(pageNum, pageSize)
          : undefined;

      const preset =
        kind === "preset" || kind === "all"
          ? allPages
            ? await listAllPages("preset")
            : await listPresetElements(pageNum, pageSize)
          : undefined;

      const eligiblePrefix = BRAND_ELEMENT_NAME_PREFIX;
      const withEligibility = <T extends { id: string; name: string }>(elements: T[]) =>
        elements.map((e) => ({
          ...e,
          eligible: isElementNameEligible(e.name, eligiblePrefix),
        }));

      const customWithEligibility = custom ? withEligibility(custom) : undefined;
      const presetWithEligibility = preset ? withEligibility(preset) : undefined;

      const summary = {
        eligible_prefix: eligiblePrefix,
        custom_count: custom?.length ?? 0,
        preset_count: preset?.length ?? 0,
        total_count: (custom?.length ?? 0) + (preset?.length ?? 0),
        eligible_custom_count: customWithEligibility?.filter((e) => e.eligible).length ?? 0,
        eligible_preset_count: presetWithEligibility?.filter((e) => e.eligible).length ?? 0,
        eligible_total_count:
          (customWithEligibility?.filter((e) => e.eligible).length ?? 0) +
          (presetWithEligibility?.filter((e) => e.eligible).length ?? 0),
      };

      function normalizeName(name: string): string {
        return name.trim().toLowerCase().replace(/\s+/g, " ");
      }

      function findDuplicates(elements: Array<{ id: string; name: string }>) {
        const map = new Map<string, { name: string; ids: string[] }>();
        for (const el of elements) {
          const key = normalizeName(el.name);
          const entry = map.get(key) ?? { name: el.name.trim(), ids: [] };
          entry.ids.push(el.id);
          map.set(key, entry);
        }
        return Array.from(map.values())
          .filter((v) => v.ids.length > 1)
          .sort((a, b) => b.ids.length - a.ids.length);
      }

      return json(
        {
          mode: "elements",
          base_url: baseUrl,
          kind,
          paging: allPages
            ? { mode: "all", pageSize, maxPages }
            : { mode: "page", pageNum, pageSize },
          summary,
          cleanup: {
            custom_duplicates: custom ? findDuplicates(custom) : [],
            preset_duplicates: preset ? findDuplicates(preset) : [],
          },
          custom: customWithEligibility,
          preset: presetWithEligibility,
        },
        200
      );
    }

    // Utility mode: bulk-create Kling custom elements from publicly accessible image URLs.
    // POST /functions/v1/test-prompt?mode=elements-create
    // Headers: x-admin-secret: <WEBHOOK_SECRET>
    // Body:
    // {
    //   "assets_base_url": "https://<your-vercel-deployment>",
    //   "elements": [
    //     {
    //       "name": "bluestone-anya",
    //       "description": "Optional",
    //       "frontal_path": "/kling-elements/bluestone-anya/front.jpg",
    //       "ref_paths": ["/kling-elements/bluestone-anya/ref1.jpg"]
    //     }
    //   ],
    //   "dry_run": false,
    //   "on_existing": "skip"
    // }
    if (req.method === "POST" && mode === "elements-create") {
      const adminSecret = req.headers.get("x-admin-secret") ?? "";
      const expected = Deno.env.get("WEBHOOK_SECRET") ?? "";
      if (!expected) {
        return json({ error: "Server misconfigured: WEBHOOK_SECRET not set" }, 500);
      }
      if (adminSecret !== expected) {
        return json({ error: "Unauthorized" }, 401);
      }

      const body = (await req.json()) as Record<string, unknown>;
      const assetsBaseUrlRaw =
        (body.assets_base_url as string | undefined) ??
        (body.assetsBaseUrl as string | undefined);

      if (!assetsBaseUrlRaw || typeof assetsBaseUrlRaw !== "string") {
        return json({ error: "Missing assets_base_url" }, 400);
      }

      let assetsBaseUrl: URL;
      try {
        assetsBaseUrl = new URL(assetsBaseUrlRaw);
      } catch {
        return json({ error: "Invalid assets_base_url (must be a full URL)" }, 400);
      }

      if (assetsBaseUrl.protocol !== "https:" && assetsBaseUrl.protocol !== "http:") {
        return json({ error: "assets_base_url must be http(s)" }, 400);
      }

      const elementsRaw = body.elements;
      if (!Array.isArray(elementsRaw) || elementsRaw.length === 0) {
        return json({ error: "Missing elements (array)" }, 400);
      }
      if (elementsRaw.length > 10) {
        return json({ error: "Too many elements in one request (max 10)" }, 400);
      }

      const dryRun =
        (body.dry_run as boolean | undefined) ?? (body.dryRun as boolean | undefined) ??
        false;
      const onExisting =
        (body.on_existing as string | undefined) ?? (body.onExisting as string | undefined) ??
        "skip";

      function resolveAssetUrl(
        maybeUrl: unknown,
        maybePath: unknown
      ): string | null {
        if (typeof maybeUrl === "string" && /^https?:\/\//i.test(maybeUrl.trim())) {
          return maybeUrl.trim();
        }
        if (typeof maybePath !== "string") return null;
        const p = maybePath.trim();
        if (!p.startsWith("/") || p.includes("..")) return null;
        return new URL(p, assetsBaseUrl).toString();
      }

      async function probeImageUrl(imageUrl: string): Promise<{ ok: boolean; status: number; content_type?: string }> {
        try {
          const head = await fetch(imageUrl, { method: "HEAD" });
          if (head.ok) {
            return {
              ok: true,
              status: head.status,
              content_type: head.headers.get("content-type") ?? undefined,
            };
          }
          // Some servers might not support HEAD; fall back to a minimal GET.
          if (head.status === 405) {
            const get = await fetch(imageUrl, {
              method: "GET",
              headers: { Range: "bytes=0-0" },
            });
            return {
              ok: get.ok,
              status: get.status,
              content_type: get.headers.get("content-type") ?? undefined,
            };
          }
          return { ok: false, status: head.status };
        } catch {
          return { ok: false, status: 0 };
        }
      }

      // Load all existing custom elements so we can skip duplicates by name.
      const existing = (() => {
        const map = new Map<string, { id: string; name: string }>();
        return { map };
      })();

      // Keep this bounded; most accounts have a small set of custom elements.
      for (let page = 1; page <= 20; page++) {
        const pageEls = await listCustomElements(page, 100);
        for (const el of pageEls) {
          existing.map.set(el.name.trim().toLowerCase(), { id: el.id, name: el.name });
        }
        if (pageEls.length < 100) break;
      }

      type NormalizedInput = {
        name: string;
        description: string;
        frontal_url: string;
        ref_urls: string[];
      };

      const normalized: NormalizedInput[] = [];
      const validationErrors: Array<{ index: number; name?: string; error: string }> = [];

      for (let i = 0; i < elementsRaw.length; i++) {
        const el = elementsRaw[i] as Record<string, unknown>;
        const name = String(el?.name ?? "").trim();
        if (!name) {
          validationErrors.push({ index: i, error: "Missing element name" });
          continue;
        }
        if (!isElementNameEligible(name, BRAND_ELEMENT_NAME_PREFIX)) {
          validationErrors.push({
            index: i,
            name,
            error: `Element name must start with "${BRAND_ELEMENT_NAME_PREFIX}"`,
          });
          continue;
        }

        const description =
          typeof el?.description === "string" && el.description.trim().length > 0
            ? el.description.trim()
            : name;

        const frontalUrl = resolveAssetUrl(el?.frontal_url ?? el?.frontalUrl, el?.frontal_path ?? el?.frontalPath);
        if (!frontalUrl) {
          validationErrors.push({
            index: i,
            name,
            error: "Missing frontal_url/frontal_path (must be a full URL or an absolute path starting with /)",
          });
          continue;
        }

        const refUrlsRaw =
          (Array.isArray(el?.ref_urls) ? el.ref_urls : undefined) ??
          (Array.isArray(el?.refUrls) ? el.refUrls : undefined);
        const refPathsRaw =
          (Array.isArray(el?.ref_paths) ? el.ref_paths : undefined) ??
          (Array.isArray(el?.refPaths) ? el.refPaths : undefined);

        const refUrlsResolved: string[] = [];
        if (Array.isArray(refUrlsRaw)) {
          for (const u of refUrlsRaw) {
            const resolved = resolveAssetUrl(u, null);
            if (resolved) refUrlsResolved.push(resolved);
          }
        }
        if (Array.isArray(refPathsRaw)) {
          for (const p of refPathsRaw) {
            const resolved = resolveAssetUrl(null, p);
            if (resolved) refUrlsResolved.push(resolved);
          }
        }

        const refUrls = refUrlsResolved.filter(Boolean);
        if (refUrls.length < 1 || refUrls.length > 3) {
          validationErrors.push({
            index: i,
            name,
            error: "Provide 1-3 reference images via ref_urls/ref_paths",
          });
          continue;
        }

        normalized.push({
          name,
          description,
          frontal_url: frontalUrl,
          ref_urls: refUrls,
        });
      }

      // Preflight probes before any creation
      for (let i = 0; i < normalized.length; i++) {
        const el = normalized[i];
        const urls = [el.frontal_url, ...el.ref_urls];
        const probes = await Promise.all(urls.map((u) => probeImageUrl(u)));
        const badIdx = probes.findIndex((p) => !p.ok);
        if (badIdx !== -1) {
          validationErrors.push({
            index: i,
            name: el.name,
            error: `Image URL not reachable (${urls[badIdx]}). Status: ${probes[badIdx].status || "network error"}`,
          });
        }
      }

      if (validationErrors.length > 0) {
        return json(
          {
            error: "Validation failed",
            eligible_prefix: BRAND_ELEMENT_NAME_PREFIX,
            assets_base_url: assetsBaseUrl.toString(),
            details: validationErrors,
          },
          400
        );
      }

      const results: Array<Record<string, unknown>> = [];
      for (const el of normalized) {
        const existingMatch = existing.map.get(el.name.trim().toLowerCase());
        if (existingMatch) {
          if (onExisting === "error") {
            results.push({
              name: el.name,
              status: "error",
              error: `Element already exists (${existingMatch.name} / ${existingMatch.id})`,
            });
            continue;
          }
          results.push({
            name: el.name,
            status: "skipped_existing",
            existing: existingMatch,
          });
          continue;
        }

        const reqBody = {
          element_name: el.name,
          element_description: el.description,
          element_frontal_image: el.frontal_url,
          element_refer_list: el.ref_urls.map((u) => ({ image_url: u })),
        };

        if (dryRun) {
          results.push({ name: el.name, status: "dry_run", request: reqBody });
          continue;
        }

        const res = await createCustomElement(reqBody);
        results.push({ name: el.name, status: "created", response: res });
      }

      return json(
        {
          mode: "elements-create",
          eligible_prefix: BRAND_ELEMENT_NAME_PREFIX,
          assets_base_url: assetsBaseUrl.toString(),
          dry_run: dryRun,
          results,
        },
        200
      );
    }

    // Default mode: generate the Gemini prompt for a given BlueStone product URL.
    // This is intentionally POST-only to avoid confusing "Unexpected end of JSON input"
    // errors when calling the function with GET from tools like Postman.
    if (req.method !== "POST") {
      return json(
        {
          error:
            "Method not allowed. Use POST with JSON body { \"url\": \"https://www.bluestone.com/...\" } " +
            "or GET with mode=elements to list Kling elements.",
        },
        405
      );
    }

    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      if (!text.trim()) {
        return json({ error: "Missing JSON body" }, 400);
      }
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const url = body.url;

    // Validate URL (match create-run behavior)
    if (!url || typeof url !== "string") {
      return json({ error: "Missing url" }, 400);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return json({ error: "Invalid URL" }, 400);
    }

    if (!parsed.hostname.includes("bluestone.com")) {
      return json({ error: "Only BlueStone URLs are supported" }, 400);
    }

    // Scrape product (same as production)
    const product = await scrapeProduct(url);

    // Generate Gemini prompt using the exact same logic as create-run
    const { prompt, request } = await generateKlingPromptWithGemini(
      {
        product_title: product.product_title,
        product_description: product.product_description,
        product_category: product.product_category,
      },
      product.input_images.length
    );

    const expectedImageTokens = request.imageRefs;
    const imageTokensUsed = expectedImageTokens.filter((t) =>
      prompt.includes(t)
    );
    const hasElement1 = prompt.includes("<<<element_1>>>");
    const hasShot1 = /^\s*(?:-\s*)?Shot 1 \(0-5s\):/m.test(prompt);
    const hasShot2 = /^\s*(?:-\s*)?Shot 2 \(5-10s\):/m.test(prompt);

    return json({
      status: "dry_run_complete",
      product: {
        title: product.product_title,
        category: product.product_category,
        image_count: product.input_images.length,
        images: product.input_images,
      },
      gemini: {
        model: request.model,
        generation_config: request.generationConfig,
        system_prompt: request.systemPrompt,
        user_message: request.userMessage,
        output: prompt,
      },
      validation: {
        has_element_1: hasElement1,
        has_shot_1: hasShot1,
        has_shot_2: hasShot2,
        image_tokens_used: imageTokensUsed,
        image_tokens_expected: expectedImageTokens,
        valid:
          hasElement1 &&
          hasShot1 &&
          hasShot2 &&
          imageTokensUsed.length === expectedImageTokens.length,
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
