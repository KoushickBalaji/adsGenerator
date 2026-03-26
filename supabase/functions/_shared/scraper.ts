// BlueStone product data scraper
// Combines the internal API (for product metadata) with HTML scraping (for gallery images).

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

export type ProductData = {
  product_title: string;
  product_description: string;
  product_category: string;
  input_images: string[]; // up to 4 high-res product images
};

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const MAX_IMAGES = 4;

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

export async function scrapeProduct(url: string): Promise<ProductData> {
  const cleanUrl = new URL(url);
  cleanUrl.search = "";
  const cleanUrlStr = cleanUrl.toString();
  const designId = extractDesignId(cleanUrlStr);

  // Run both strategies in parallel:
  // 1. API for metadata (title, category)
  // 2. HTML for gallery images (multiple angles)
  const [apiData, htmlImages] = await Promise.all([
    designId ? fetchMetadataFromApi(designId, cleanUrlStr) : Promise.resolve(null),
    fetchGalleryImagesFromHtml(cleanUrlStr),
  ]);

  // Prefer API metadata, fall back to HTML scraping for everything
  if (apiData) {
    // Use gallery images if we got them, else fall back to the API thumbnail
    const images = htmlImages.length > 0 ? htmlImages : apiData.fallbackImages;
    return {
      product_title: apiData.name,
      product_description: `${apiData.name} - Premium ${apiData.category} from BlueStone`,
      product_category: apiData.category,
      input_images: images.slice(0, MAX_IMAGES),
    };
  }

  // Full HTML fallback
  return scrapeFromHtml(cleanUrlStr, htmlImages);
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
      if (fallbackImages.length >= MAX_IMAGES) break;
    }

    return { name, category, fallbackImages };
  } catch {
    return null;
  }
}

// ─── Strategy 2: HTML gallery images ───

async function fetchGalleryImagesFromHtml(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
    });

    if (!res.ok) return [];

    const html = await res.text();

    // Extract the product code from the URL to filter product-specific images
    // e.g. "BS-R28" from the image paths
    const productCodeMatch = html.match(/giproduct\/([\w-]+?)_/);
    const productCode = productCodeMatch ? productCodeMatch[1] : null;

    if (!productCode) return [];

    // Find all high-res (w_1024) product images matching this product code
    const imageRegex = new RegExp(
      `https://kinclimg\\d+\\.bluestone\\.com/[^"']+${productCode}[^"']+\\.(png|jpg|jpeg)`,
      "g"
    );
    const allMatches = html.match(imageRegex) || [];

    // Deduplicate by image path, keep only w_1024 versions, exclude posters/videos
    const seen = new Set<string>();
    const images: string[] = [];

    for (const imgUrl of allMatches) {
      // Only high-res versions
      if (!imgUrl.includes("w_1024")) continue;
      // Skip video posters
      if (imgUrl.includes("POSTER")) continue;

      const key = imagePathKey(imgUrl);
      if (!seen.has(key)) {
        seen.add(key);
        images.push(toHighRes(imgUrl));
      }
      if (images.length >= MAX_IMAGES) break;
    }

    return images;
  } catch {
    return [];
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
          input_images: images.slice(0, MAX_IMAGES),
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
      input_images: images.slice(0, MAX_IMAGES),
    };
  }

  // Last resort
  if (preloadedImages.length > 0) {
    return {
      product_title: "BlueStone Product",
      product_description: "",
      product_category: extractCategoryFromUrl(url),
      input_images: preloadedImages.slice(0, MAX_IMAGES),
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
