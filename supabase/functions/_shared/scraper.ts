// BlueStone product data scraper
// Combines the internal API (for product metadata) with HTML scraping (for gallery images).

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

export type ProductData = {
  product_title: string;
  product_description: string;
  product_category: string;
  // Reference product images (highest quality available). We may keep more than 3 for
  // prompt-only context, but Kling uses only the first 3.
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
  opts: { debug?: boolean } = {}
): Promise<ProductData> {
  const cleanUrl = new URL(url);
  cleanUrl.search = "";
  const cleanUrlStr = cleanUrl.toString();
  const designId = extractDesignId(cleanUrlStr);

  // Run both strategies in parallel:
  // 1. API for metadata (title, category)
  // 2. HTML for gallery images (multiple angles)
  const [apiData, htmlGallery] = await Promise.all([
    designId ? fetchMetadataFromApi(designId, cleanUrlStr) : Promise.resolve(null),
    fetchGalleryMediaFromHtml(cleanUrlStr),
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
    // Use gallery images if we got them, else fall back to the API thumbnail
    const images = htmlImages.length > 0 ? htmlImages : apiData.fallbackImages;
    return {
      product_title: apiData.name,
      product_description: `${apiData.name} - Premium ${apiData.category} from BlueStone`,
      product_category: apiData.category,
      input_images: images.slice(0, MAX_REFERENCE_IMAGES),
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
  const fallback = await scrapeFromHtml(cleanUrlStr, htmlImages);
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

async function fetchGalleryMediaFromHtml(url: string): Promise<{
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

    // Deduplicate by image path, keep only w_1024 versions for selection, exclude posters/videos
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

      // For selection, keep only explicit high-res versions and skip video posters
      if (!imgUrl.includes("w_1024")) continue;
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
        ? productOnly.slice(0, MAX_REFERENCE_IMAGES)
        : lifestyle.slice(0, MAX_REFERENCE_IMAGES);
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
        selected_for_kling: selected.slice(0, 3),
        selected_for_gemini: selected,
      },
    };
  } catch {
    return { images: [], debug: null };
  }
}

// ─── Full HTML fallback (no API data) ───

async function scrapeFromHtml(url: string, preloadedImages: string[]): Promise<ProductData> {
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

  // Try JSON-LD
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || "");
      if (data["@type"] === "Product" && data.name) {
        const ldImages: string[] = [];
        if (typeof data.image === "string") ldImages.push(data.image);
        else if (Array.isArray(data.image)) ldImages.push(...data.image);

        const images = preloadedImages.length > 0 ? preloadedImages : ldImages;
        return {
          product_title: data.name,
          product_description: data.description || "",
          product_category: inferCategory(data.name, data.category || ""),
          input_images: images.slice(0, MAX_REFERENCE_IMAGES),
        };
      }
    } catch { /* skip */ }
  }

  // Try OG tags
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute("content");

  if (ogTitle && ogImage) {
    const images = preloadedImages.length > 0 ? preloadedImages : [ogImage];
    return {
      product_title: ogTitle,
      product_description: ogDesc || "",
      product_category: inferCategory(ogTitle, ""),
      input_images: images.slice(0, MAX_REFERENCE_IMAGES),
    };
  }

  // Last resort
  if (preloadedImages.length > 0) {
    return {
      product_title: "BlueStone Product",
      product_description: "",
      product_category: extractCategoryFromUrl(url),
      input_images: preloadedImages.slice(0, MAX_REFERENCE_IMAGES),
    };
  }

  throw new Error("Could not extract product details from this URL");
}

function inferCategory(title: string, category: string): string {
  if (category) return category.toLowerCase();
  const lower = title.toLowerCase();
  const categories = [
    "ring", "necklace", "pendant", "earring", "bracelet",
    "bangle", "chain", "mangalsutra",
  ];
  for (const cat of categories) {
    if (lower.includes(cat)) return cat;
  }
  return "jewellery";
}
