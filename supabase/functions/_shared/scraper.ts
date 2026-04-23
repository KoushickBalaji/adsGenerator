// BlueStone product data scraper
// Combines the internal API (for product metadata) with HTML scraping (for gallery images).

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

export type ProductData = {
  product_title: string;
  product_description: string;
  product_category: string;
  // Reference product images (highest quality available). We may keep more than 4 for
  // prompt-only context, but Kling uses only the first 4.
  input_images: string[]; // up to 12 reference images
  scrape_debug?: ProductScrapeDebug;
};

export type GalleryMediaDebug = {
  product_code: string | null;
  has_video_items: boolean;
  image_urls_unique: string[];
  image_urls_highres_unique: string[];
  video_urls_unique: string[];
  excluded_video_thumbnails: string[];
  deprioritized_lifestyle_images: string[];
  selected_input_images: string[];
  selected_for_kling: string[];
  selected_for_gemini: string[];
};

export type ProductScrapeDebug = {
  clean_url: string;
  design_id: string | null;
  api_used: boolean;
  api_fallback_images: string[];
  html_gallery: GalleryMediaDebug | null;
};

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Keep this fairly small: these images are stored on the run row (shown in the UI),
// and can also be sent to Gemini as multimodal reference context.
const MAX_REFERENCE_IMAGES = 12;

export type ScraperAdapter = "bluestone" | "generic" | "shopify";

function normalizeScrapedImageUrl(raw: string, baseUrl: string): string | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  // Strip wrapper quotes that sometimes appear inside attributes/JSON.
  let candidate = trimmed.replace(/^["']+/, "").replace(/["']+$/, "").trim();
  if (!candidate) return null;

  // Fix common malformed pattern: "https://host//host/path..."
  candidate = candidate.replace(
    /^https?:\/\/([^/]+)\/\/\1\//i,
    "https://$1/"
  );

  // Protocol-relative URLs: //cdn...
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;

  // Force https when the site supports it (most modern ecommerce sites do).
  if (candidate.startsWith("http://")) candidate = `https://${candidate.slice("http://".length)}`;

  try {
    const url = new URL(candidate, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "https:";
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeScrapedImageUrls(rawUrls: string[], baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawUrls) {
    const u = normalizeScrapedImageUrl(raw, baseUrl);
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function stripHtmlTags(htmlLike: string): string {
  return String(htmlLike || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonLdProduct(obj: Record<string, unknown>): boolean {
  const typeValue = obj["@type"];
  if (typeof typeValue === "string") return typeValue.toLowerCase() === "product";
  if (Array.isArray(typeValue)) {
    return typeValue.some(
      (t) => typeof t === "string" && t.toLowerCase() === "product"
    );
  }
  return false;
}

function findFirstJsonLdProduct(data: unknown): Record<string, unknown> | null {
  const visited = new Set<unknown>();

  const walk = (node: unknown): Record<string, unknown> | null => {
    if (!node) return null;
    if (visited.has(node)) return null;
    if (Array.isArray(node)) {
      visited.add(node);
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (isRecord(node)) {
      visited.add(node);
      if (isJsonLdProduct(node) && typeof node.name === "string" && node.name.trim()) {
        return node;
      }

      // JSON-LD commonly nests entities under @graph.
      if (node["@graph"] != null) {
        const found = walk(node["@graph"]);
        if (found) return found;
      }

      for (const v of Object.values(node)) {
        const found = walk(v);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(data);
}

function extractJsonLdImageUrls(product: Record<string, unknown>): string[] {
  const out: string[] = [];

  const pushUrl = (value: unknown) => {
    if (!value) return;
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (isRecord(value)) {
      const url =
        (typeof value.url === "string" && value.url) ||
        (typeof value.contentUrl === "string" && value.contentUrl) ||
        (typeof value.src === "string" && value.src) ||
        (typeof value["@id"] === "string" && value["@id"]) ||
        null;
      if (url) out.push(url);
    }
  };

  const image = product.image;
  if (Array.isArray(image)) {
    for (const item of image) pushUrl(item);
  } else {
    pushUrl(image);
  }

  return out;
}

function extractShopifyHandle(pathname: string): string | null {
  const parts = String(pathname || "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  const idx = parts.findIndex((p) => p.toLowerCase() === "products");
  if (idx < 0) return null;
  const handle = parts[idx + 1] ?? "";
  return handle ? handle : null;
}

function looksLikeImageUrl(url: string): boolean {
  return /\.(?:png|jpe?g|webp|avif|gif)(?:\?|$)/i.test(url);
}

function pickBestSrcsetUrl(srcset: string): string | null {
  const raw = String(srcset || "").trim();
  if (!raw) return null;

  // srcset = "url1 300w, url2 600w, url3 900w"
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;

  const last = entries[entries.length - 1];
  const url = last.split(/\s+/)[0]?.trim();
  return url ? url : null;
}

function extractGalleryImageCandidates(doc: unknown, baseUrl: string): string[] {
  // Note: Deno DOM types aren't available here, so treat doc as `any`.
  const d = doc as any;
  const raw: string[] = [];

  try {
    // WooCommerce / generic product galleries often expose full-size images in anchors.
    const anchorEls = d.querySelectorAll?.(
      ".woocommerce-product-gallery a[href]"
    );
    if (anchorEls && typeof anchorEls[Symbol.iterator] === "function") {
      for (const a of anchorEls) {
        const href = a?.getAttribute?.("href") || "";
        if (!href) continue;
        if (!looksLikeImageUrl(href)) continue;
        raw.push(href);
        if (raw.length >= 40) break;
      }
    }

    const imgEls = d.querySelectorAll?.(
      ".woocommerce-product-gallery img, img[data-large_image], img[data-zoom-image], img[data-large-image]"
    );
    if (imgEls && typeof imgEls[Symbol.iterator] === "function") {
      for (const img of imgEls) {
        const candidates = [
          img?.getAttribute?.("data-large_image"),
          img?.getAttribute?.("data-zoom-image"),
          img?.getAttribute?.("data-large-image"),
          img?.getAttribute?.("data-src"),
          img?.getAttribute?.("src"),
          pickBestSrcsetUrl(img?.getAttribute?.("data-srcset") || ""),
          pickBestSrcsetUrl(img?.getAttribute?.("srcset") || ""),
        ]
          .map((v) => String(v || "").trim())
          .filter(Boolean)
          .filter((u) => looksLikeImageUrl(u));

        raw.push(...candidates);
        if (raw.length >= 60) break;
      }
    }
  } catch {
    // ignore
  }

  return normalizeScrapedImageUrls(raw, baseUrl);
}

function extractMelorraEnlargedImageUrls(html: string, pageUrl: string): string[] {
  let hostname = "";
  try {
    hostname = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return [];
  }

  // Melorra product pages often embed a JS state object with "enlarged_images":
  //   ["AU/OPT/1024/<code>_P_1024.png", "AU/OPT/1024/<code>_F_1024.png", ...]
  // Those URLs are not always present as full absolute URLs in the initial HTML.
  if (!hostname.endsWith("melorra.com")) return [];

  const hostMatch =
    /https?:\/\/([^\/"'\s>]+)\/fit-in\/\d+x\d+\/dev\/catalogue\/images\//i.exec(html);
  const cdnHost = hostMatch?.[1] ? hostMatch[1].trim() : "photos.melorra.com";
  const base = `https://${cdnHost}/fit-in/1024x1024/dev/catalogue/images/`;

  const pathRe =
    /\b[A-Z]{2}\/OPT\/(?:BW\/)?1024\/[^"'\s>]+?\.(?:png|jpe?g)\b/gi;
  const matches = html.match(pathRe) ?? [];
  const paths = Array.from(
    new Set(matches.map((s) => s.trim()).filter(Boolean))
  );

  if (paths.length === 0) return [];

  const urls = paths.map((p) => `${base}${p}`);
  return normalizeScrapedImageUrls(urls, pageUrl);
}

async function scrapeFromShopify(url: string, maxReferenceImages: number): Promise<ProductData> {
  const parsed = new URL(url);
  const handle = extractShopifyHandle(parsed.pathname);

  if (!handle) {
    // Not a canonical /products/<handle> URL - fall back to generic HTML scraping.
    return await scrapeFromHtml(url, [], maxReferenceImages);
  }

  const base = parsed.origin.replace(/\/+$/, "");
  const jsUrl = `${base}/products/${handle}.js`;
  const jsonUrl = `${base}/products/${handle}.json`;

  type ShopifyProductShape = {
    title?: unknown;
    description?: unknown;
    body_html?: unknown;
    product_type?: unknown;
    type?: unknown;
    images?: unknown;
    featured_image?: unknown;
  };

  const fetchProductJson = async (endpoint: string): Promise<ShopifyProductShape | null> => {
    try {
      const res = await fetch(endpoint, {
        headers: {
          ...BROWSER_HEADERS,
          Accept: "application/json,*/*;q=0.8",
        },
        redirect: "follow",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as unknown;
      if (isRecord(data) && isRecord(data.product)) return data.product as ShopifyProductShape;
      if (isRecord(data)) return data as ShopifyProductShape;
      return null;
    } catch {
      return null;
    }
  };

  const product = (await fetchProductJson(jsUrl)) ?? (await fetchProductJson(jsonUrl));
  if (!product) {
    // Fallback: Shopify JSON endpoints disabled or blocked.
    return await scrapeFromHtml(url, [], maxReferenceImages);
  }

  const title = typeof product.title === "string" ? product.title.trim() : "";
  const descriptionRaw =
    typeof product.description === "string"
      ? product.description
      : typeof product.body_html === "string"
        ? product.body_html
        : "";
  const description = stripHtmlTags(descriptionRaw);

  const categoryHint =
    typeof product.product_type === "string"
      ? product.product_type
      : typeof product.type === "string"
        ? product.type
        : "";

  const rawImages: string[] = [];

  // Prefer featured image first.
  if (typeof product.featured_image === "string" && product.featured_image.trim()) {
    rawImages.push(product.featured_image.trim());
  }

  const images = (product.images ?? null) as unknown;
  if (Array.isArray(images)) {
    for (const img of images) {
      if (typeof img === "string" && img.trim()) rawImages.push(img.trim());
      else if (isRecord(img) && typeof img.src === "string" && img.src.trim()) {
        rawImages.push(img.src.trim());
      }
    }
  }

  const normalized = normalizeScrapedImageUrls(rawImages, url).slice(0, maxReferenceImages);
  if (!title || normalized.length === 0) {
    // As a last resort, use HTML extraction (OG tags / JSON-LD).
    return await scrapeFromHtml(url, normalized, maxReferenceImages);
  }

  return {
    product_title: title,
    product_description: description,
    product_category: inferCategory(title, categoryHint),
    input_images: normalized.slice(0, maxReferenceImages),
  };
}

/**
 * Extract the design ID from a BlueStone product URL.
 * Format: /category/product-name~DESIGN_ID.html
 */
function extractDesignId(url: string): string | null {
  const match = url.match(/~(\d+)\.html/);
  return match ? match[1] : null;
}

/**
 * Extract category from the URL path.
 */
function extractCategoryFromUrl(url: string): string {
  const path = new URL(url).pathname;
  const segment = path.split("/").filter(Boolean)[0] || "";
  const singular = segment.replace(/s$/, "").toLowerCase();
  const known = [
    "ring", "necklace", "pendant", "earring", "bracelet",
    "bangle", "chain", "mangalsutra",
  ];
  return known.includes(singular) ? singular : singular || "jewellery";
}

/**
 * Normalize a BlueStone CDN image URL to high-res (w_1024) jpg.
 */
function toHighRes(url: string): string {
  return url
    .replace(/w_\d+/, "w_1024")
    .replace(/f_webp/, "f_jpg");
}

/**
 * Extract the unique image path from a CDN URL (ignoring CDN shard number and size).
 * e.g. "kinclimg9.bluestone.com/f_jpg,c_scale,w_1024,.../giproduct/BS-R28_...-PICS-00001-1024-14128.png"
 *   → "giproduct/BS-R28_...-PICS-00001-1024-14128.png"
 */
function imagePathKey(url: string): string {
  const match = url.match(/giproduct\/(.+)$/);
  return match ? match[1] : url;
}

function extractDesignKeyFromCdnUrl(url: string): string | null {
  // Prefer a design-specific key (unique per product design) rather than a coarse "BS-R28" prefix.
  // Example:
  //   giproduct/BS-R28_YAA18CITRDIG6XXXX_ABCD00-PICS-00001-1024-14128.png
  //   -> BS-R28_YAA18CITRDIG6XXXX_ABCD00
  const byPics = url.match(/giproduct\/([^/]+?)-(?:BP-)?PICS-/i);
  if (byPics) return byPics[1];

  // Fallback: first token before underscore (less specific, but better than nothing).
  const byUnderscore = url.match(/giproduct\/([\w-]+?)_/i);
  return byUnderscore ? byUnderscore[1] : null;
}

export async function scrapeProduct(
  url: string,
  opts: {
    debug?: boolean;
    adapter?: ScraperAdapter;
    maxReferenceImages?: number;
  } = {}
): Promise<ProductData> {
  const adapter: ScraperAdapter = opts.adapter ?? "bluestone";
  const maxReferenceImages = Math.min(
    MAX_REFERENCE_IMAGES,
    Math.min(20, Math.max(1, opts.maxReferenceImages ?? MAX_REFERENCE_IMAGES))
  );

  const cleanUrl = new URL(url);
  cleanUrl.search = "";
  const cleanUrlStr = cleanUrl.toString();

  // Generic/product-only fallback path (no BlueStone internal API assumptions).
  if (adapter !== "bluestone") {
    const product =
      adapter === "shopify"
        ? await scrapeFromShopify(cleanUrlStr, maxReferenceImages)
        : await scrapeFromHtml(cleanUrlStr, [], maxReferenceImages);

    return {
      ...product,
      input_images: product.input_images.slice(0, maxReferenceImages),
    };
  }

  const designId = extractDesignId(cleanUrlStr);

  // Run both strategies in parallel:
  // 1. API for metadata (title, category)
  // 2. HTML for gallery images (multiple angles)
  const [apiData, htmlGallery] = await Promise.all([
    designId ? fetchMetadataFromApi(designId, cleanUrlStr) : Promise.resolve(null),
    fetchGalleryMediaFromHtml(cleanUrlStr, maxReferenceImages),
  ]);
  let htmlImages = htmlGallery.images;
  // Extra guardrail: if the internal API returned an image URL, use its design key to
  // post-filter HTML gallery candidates. This helps avoid edge cases where the HTML
  // contains other products (recommended tiles) and OG tags are missing/incorrect.
  const apiDesignKey = apiData?.fallbackImages?.[0]
    ? extractDesignKeyFromCdnUrl(apiData.fallbackImages[0])
    : null;
  if (apiDesignKey && htmlImages.length > 0) {
    const filtered = htmlImages.filter((u) => imagePathKey(u).includes(apiDesignKey));
    if (filtered.length > 0) htmlImages = filtered;
  }

  // Prefer API metadata, fall back to HTML scraping for everything
  if (apiData) {
    // Prefer gallery images, but top up from API variants if we didn't get enough angles.
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const u of [...htmlImages, ...apiData.fallbackImages]) {
      const key = imagePathKey(u);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(u);
      if (merged.length >= maxReferenceImages) break;
    }
    const images = merged.length > 0 ? merged : apiData.fallbackImages;
    return {
      product_title: apiData.name,
      product_description: `${apiData.name} - Premium ${apiData.category} from BlueStone`,
      product_category: apiData.category,
      input_images: images.slice(0, maxReferenceImages),
      ...(opts.debug
        ? {
            scrape_debug: {
              clean_url: cleanUrlStr,
              design_id: designId,
              api_used: true,
              api_fallback_images: apiData.fallbackImages,
              html_gallery: htmlGallery.debug,
            } satisfies ProductScrapeDebug,
          }
        : {}),
    };
  }

  // Full HTML fallback
  const fallback = await scrapeFromHtml(cleanUrlStr, htmlImages, maxReferenceImages);
  return {
    ...fallback,
    ...(opts.debug
      ? {
          scrape_debug: {
            clean_url: cleanUrlStr,
            design_id: designId,
            api_used: false,
            api_fallback_images: [],
            html_gallery: htmlGallery.debug,
          } satisfies ProductScrapeDebug,
        }
      : {}),
  };
}

// ─── Strategy 1: API for metadata ───

type ApiMetadata = {
  name: string;
  category: string;
  fallbackImages: string[]; // single thumbnail from API
};

async function fetchMetadataFromApi(
  designId: string,
  originalUrl: string
): Promise<ApiMetadata | null> {
  try {
    const apiUrl = `https://www.bluestone.com/deliverydate/design/get?pincode=560001&designId=${designId}&ajax=true`;
    const res = await fetch(apiUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: originalUrl,
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const detailsObj = data?.designEddDetails;
    if (!detailsObj || typeof detailsObj !== "object") return null;

    const variants = Object.values(detailsObj) as Array<{
      name?: string;
      category?: string;
      imageUrl?: string;
    }>;
    if (variants.length === 0) return null;

    const variant = variants[0];
    const name = variant.name || "";
    const category = (variant.category || extractCategoryFromUrl(originalUrl)).toLowerCase();

    if (!name) return null;

    // Collect unique images from different variants as fallback
    const seen = new Set<string>();
    const fallbackImages: string[] = [];
    for (const v of variants) {
      if (v.imageUrl) {
        const key = imagePathKey(v.imageUrl);
        if (!seen.has(key)) {
          seen.add(key);
          fallbackImages.push(toHighRes(v.imageUrl));
        }
      }
      if (fallbackImages.length >= MAX_REFERENCE_IMAGES) break;
    }

    return { name, category, fallbackImages };
  } catch {
    return null;
  }
}

// ─── Strategy 2: HTML gallery images ───

async function fetchGalleryMediaFromHtml(
  url: string,
  maxReferenceImages: number
): Promise<{
  images: string[];
  debug: GalleryMediaDebug | null;
}> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
    });

    if (!res.ok) return { images: [], debug: null };

    const html = await res.text();
    const hasVideoItems =
      html.toLowerCase().includes("video-thumb") ||
      html.toLowerCase().includes("video thumb");

    // Extract the product code from the page to filter product-specific media.
    // IMPORTANT: Don't use the first `giproduct/...` match in the HTML because pages can
    // include "recommended" product tiles before/around the main gallery.
    // Prefer the main product's OG image (almost always present) and fall back to first match.
    const ogImageMatch = html.match(
      /property=["']og:image["'][^>]*content=["']([^"']+)["']/i
    );
    const ogImageUrl = ogImageMatch ? ogImageMatch[1] : null;
    const designKey =
      (ogImageUrl ? extractDesignKeyFromCdnUrl(ogImageUrl) : null) ??
      extractDesignKeyFromCdnUrl(html);

    // Extract any video URLs (useful for debugging; not currently passed to Kling)
    const videoRegex = /https:\/\/[^"'\\s]+?\.(?:mp4|webm|m3u8)(?:\?[^"'\\s]+)?/g;
    const videoMatches = html.match(videoRegex) || [];
    const videoUrlsUnique: string[] = [];
    const seenVideo = new Set<string>();
    for (const v of videoMatches) {
      const trimmed = v.trim();
      if (!/^https?:\/\//i.test(trimmed)) continue;
      if (seenVideo.has(trimmed)) continue;
      seenVideo.add(trimmed);
      videoUrlsUnique.push(trimmed);
      if (videoUrlsUnique.length >= 50) break;
    }

    if (!designKey) {
      return {
        images: [],
        debug: {
          product_code: null,
          has_video_items: hasVideoItems,
          image_urls_unique: [],
          image_urls_highres_unique: [],
          video_urls_unique: videoUrlsUnique,
          excluded_video_thumbnails: [],
          deprioritized_lifestyle_images: [],
          selected_input_images: [],
          selected_for_kling: [],
          selected_for_gemini: [],
        },
      };
    }

    // Find all product images matching this design key (avoid "you may also like" tiles)
    const escapedDesignKey = designKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const imageRegex = new RegExp(
      `https://kinclimg\\d+\\.bluestone\\.com/[^"']+${escapedDesignKey}[^"']+\\.(png|jpg|jpeg)`,
      "g"
    );
    const allMatches = html.match(imageRegex) || [];

    // Deduplicate by image path, normalize to high-res, exclude posters/videos
    const seenAll = new Set<string>();
    const imageUrlsUnique: string[] = [];
    const seenHighRes = new Set<string>();
    const imageUrlsHighResUnique: string[] = [];

    function isLikelyVideoThumbnail(imageUrl: string): boolean {
      const lower = imageUrl.toLowerCase();
      // Known site-level placeholder for video items
      if (lower.includes("video-thumb")) return true;
      // Common poster/thumbnail naming patterns
      if (lower.includes("video_poster") || lower.includes("video-poster")) return true;
      if (/(?:^|[-_])(vid|video|vdo|poster)(?:[-_]|\\.)/.test(lower)) return true;
      return false;
    }

    function isLifestyleOrBeautyShot(imageUrl: string): boolean {
      // Bluestone convention: "-BP-" / "BP-PICS" are typically "beauty" shots (worn on hand/model),
      // which can unintentionally introduce extra jewellery (e.g., other rings/bracelets) into references.
      const key = imagePathKey(imageUrl).toLowerCase();
      return key.includes("-bp-") || key.includes("bp-pics");
    }

    for (const imgUrl of allMatches) {
      const normalized = toHighRes(imgUrl);
      const key = imagePathKey(normalized);

      if (!seenAll.has(key)) {
        seenAll.add(key);
        imageUrlsUnique.push(normalized);
      }

      // For selection, prefer high-res versions and skip video posters
      if (imgUrl.includes("POSTER")) continue;
      if (isLikelyVideoThumbnail(normalized)) continue;
      if (seenHighRes.has(key)) continue;
      seenHighRes.add(key);
      imageUrlsHighResUnique.push(normalized);
    }

    // Order selection: prefer clean product renders first so Kling doesn't pick up extra jewellery
    // from lifestyle/beauty references (and to avoid video thumbnails/posters).
    const lifestyle = imageUrlsHighResUnique.filter((u) => isLifestyleOrBeautyShot(u));
    const productOnly = imageUrlsHighResUnique.filter((u) => !isLifestyleOrBeautyShot(u));

    // Prefer clean product renders only (especially for rings) to avoid reference pollution from
    // lifestyle shots (which can include other jewellery like extra rings/bracelets).
    const selected =
      productOnly.length > 0
        ? productOnly.slice(0, maxReferenceImages)
        : lifestyle.slice(0, maxReferenceImages);
    if (productOnly.length === 0 && lifestyle.length > 0) {
      console.warn(
        `[scrapeProduct] Only lifestyle/beauty images found for ${designKey}; using them as fallback.`
      );
    }

    const excludedVideoThumbs = imageUrlsUnique.filter((u) => isLikelyVideoThumbnail(u));
    return {
      images: selected,
      debug: {
        product_code: designKey,
        has_video_items: hasVideoItems,
        image_urls_unique: imageUrlsUnique,
        image_urls_highres_unique: imageUrlsHighResUnique,
        video_urls_unique: videoUrlsUnique,
        excluded_video_thumbnails: excludedVideoThumbs,
        deprioritized_lifestyle_images: lifestyle,
        selected_input_images: selected,
        selected_for_kling: selected.slice(0, 4),
        selected_for_gemini: selected,
      },
    };
  } catch {
    return { images: [], debug: null };
  }
}

// ─── Full HTML fallback (no API data) ───

async function scrapeFromHtml(
  url: string,
  preloadedImages: string[],
  maxReferenceImages: number
): Promise<ProductData> {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch product page: ${res.status}`);
  }

  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) throw new Error("Failed to parse HTML");

  const melorraEnlargedImages = extractMelorraEnlargedImageUrls(html, url);
  const galleryCandidates = extractGalleryImageCandidates(doc, url);
  const supplementalImages = [
    ...preloadedImages,
    // Put Melorra "enlarged_images" first so the first 4 slots are product angles
    // even when Gemini image selection can't run (e.g. <4 loadable candidates).
    ...melorraEnlargedImages,
    ...galleryCandidates,
  ];

  // Try JSON-LD
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || "");
      const product = findFirstJsonLdProduct(data);
      if (product && typeof product.name === "string" && product.name.trim()) {
        const ldImages = extractJsonLdImageUrls(product);
        const merged = [...supplementalImages, ...ldImages];
        const normalized = normalizeScrapedImageUrls(merged, url);
        if (normalized.length > 0) {
          const name = product.name.trim();
          const description =
            typeof product.description === "string" ? product.description : "";
          const category =
            typeof product.category === "string" ? product.category : "";

          return {
            product_title: name,
            product_description: description,
            product_category: inferCategory(name, category),
            input_images: normalized.slice(0, maxReferenceImages),
          };
        }
      }
    } catch { /* skip */ }
  }

  // Try OG tags
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const ogImages = Array.from(
    doc.querySelectorAll(
      'meta[property="og:image"], meta[property="og:image:secure_url"]'
    )
  )
    .map((el) => el.getAttribute("content") || "")
    .map((s) => s.trim())
    .filter(Boolean);
  const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute("content");

  if (ogTitle && ogImages.length > 0) {
    const merged = [...supplementalImages, ...ogImages];
    const normalized = normalizeScrapedImageUrls(merged, url);
    return {
      product_title: ogTitle,
      product_description: ogDesc || "",
      product_category: inferCategory(ogTitle, ""),
      input_images: normalized.slice(0, maxReferenceImages),
    };
  }

  // Last resort
  if (supplementalImages.length > 0) {
    const normalized = normalizeScrapedImageUrls(supplementalImages, url);
    return {
      product_title: "Product",
      product_description: "",
      product_category: extractCategoryFromUrl(url),
      input_images: normalized.slice(0, maxReferenceImages),
    };
  }

  throw new Error("Could not extract product details from this URL");
}

function inferCategory(title: string, category: string): string {
  const haystack = `${category || ""} ${title || ""}`.toLowerCase();

  // Important: use word boundaries so substrings like "earrings" don't get misclassified as "ring".
  // Also handle simple plurals/splits (e.g. "mangal sutra").
  const patterns: Array<{ category: string; re: RegExp }> = [
    { category: "earring", re: /\bear[\s-]*rings?\b/ },
    { category: "ring", re: /\brings?\b/ },
    { category: "necklace", re: /\bnecklaces?\b/ },
    { category: "pendant", re: /\bpendants?\b/ },
    { category: "bracelet", re: /\bbracelets?\b/ },
    { category: "bangle", re: /\bbangles?\b/ },
    { category: "chain", re: /\bchains?\b/ },
    { category: "mangalsutra", re: /\bmangalsutras?\b|\bmangal\s*sutra(?:s)?\b/ },
  ];

  for (const { category: canonical, re } of patterns) {
    if (re.test(haystack)) return canonical;
  }

  return "jewellery";
}
