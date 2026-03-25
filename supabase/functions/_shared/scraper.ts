// BlueStone product data scraper
// Uses BlueStone's internal delivery-date API for structured data,
// falls back to HTML scraping with deno-dom.

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

export type ProductData = {
  product_title: string;
  product_description: string;
  product_category: string;
  input_images: string[];
};

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Extract the design ID from a BlueStone product URL.
 * Format: /category/product-name~DESIGN_ID.html
 * Example: /rings/the-gianna-ring~29595.html → 29595
 */
function extractDesignId(url: string): string | null {
  const match = url.match(/~(\d+)\.html/);
  return match ? match[1] : null;
}

/**
 * Extract category from the URL path.
 * Example: /rings/the-gianna-ring~29595.html → ring
 */
function extractCategoryFromUrl(url: string): string {
  const path = new URL(url).pathname;
  const segment = path.split("/").filter(Boolean)[0] || "";
  // BlueStone uses plural in URLs (rings, necklaces, earrings)
  const singular = segment.replace(/s$/, "").toLowerCase();
  const known = ["ring", "necklace", "pendant", "earring", "bracelet", "bangle", "chain", "mangalsutra"];
  return known.includes(singular) ? singular : singular || "jewellery";
}

/**
 * Get the highest-resolution image URL from BlueStone's CDN pattern.
 * Their CDN: https://kinclimg{N}.bluestone.com/f_{format},c_scale,w_{width},b_rgb:{bg}/{path}
 * We request w_1024 for high-res.
 */
function toHighResImage(imageUrl: string): string {
  // If already a full CDN URL, bump the width
  if (imageUrl.includes("kinclimg")) {
    return imageUrl.replace(/w_\d+/, "w_1024");
  }
  return imageUrl;
}

export async function scrapeProduct(url: string): Promise<ProductData> {
  // Clean the URL
  const cleanUrl = new URL(url);
  cleanUrl.search = "";
  const cleanUrlStr = cleanUrl.toString();

  // Strategy 1: BlueStone internal API (fastest, most reliable)
  const designId = extractDesignId(cleanUrlStr);
  if (designId) {
    const apiData = await fetchFromBluestoneApi(designId, cleanUrlStr);
    if (apiData) return apiData;
  }

  // Strategy 2: HTML scraping fallback
  return await scrapeFromHtml(cleanUrlStr);
}

/**
 * Strategy 1: Use BlueStone's delivery date API to get product data.
 * GET /deliverydate/design/get?pincode=560001&designId={id}&ajax=true
 * Returns variant details including name, category, imageUrl.
 */
async function fetchFromBluestoneApi(
  designId: string,
  originalUrl: string
): Promise<ProductData | null> {
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
    const details = data?.designEddDetails;
    if (!details || !Array.isArray(details) || details.length === 0) return null;

    // Pick the first variant (default customization)
    const variant = details[0];
    const name = variant.name || "";
    const category = (variant.category || extractCategoryFromUrl(originalUrl)).toLowerCase();
    const imageUrl = variant.imageUrl || "";

    if (!name || !imageUrl) return null;

    const images = [toHighResImage(imageUrl)];

    // If there are multiple variants, grab a second image for variety (optional end frame)
    if (details.length > 1 && details[1].imageUrl) {
      images.push(toHighResImage(details[1].imageUrl));
    }

    return {
      product_title: name,
      product_description: `${name} - Premium ${category} from BlueStone`,
      product_category: category,
      input_images: images,
    };
  } catch {
    return null;
  }
}

/**
 * Strategy 2: Fetch the full HTML page and scrape OG tags / meta.
 * BlueStone SSR pages do include meta tags in some cases.
 */
async function scrapeFromHtml(url: string): Promise<ProductData> {
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
  const jsonLd = extractJsonLd(doc);
  if (jsonLd) return jsonLd;

  // Try OG tags
  const og = extractOpenGraph(doc);
  if (og) return og;

  // Try HTML selectors (title tag, img tags)
  const htmlData = extractFromHtml(doc, url);
  if (htmlData) return htmlData;

  throw new Error("Could not extract product details from this URL");
}

function extractJsonLd(
  doc: ReturnType<DOMParser["parseFromString"]>
): ProductData | null {
  if (!doc) return null;

  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || "");
      const product = data["@type"] === "Product" ? data : null;
      if (!product) continue;

      const images: string[] = [];
      if (typeof product.image === "string") {
        images.push(product.image);
      } else if (Array.isArray(product.image)) {
        images.push(...product.image.slice(0, 2));
      }

      if (images.length === 0) continue;

      return {
        product_title: product.name || "",
        product_description: product.description || "",
        product_category: inferCategory(product.name || "", product.category || ""),
        input_images: images,
      };
    } catch {
      // Invalid JSON-LD, try next
    }
  }
  return null;
}

function extractOpenGraph(
  doc: ReturnType<DOMParser["parseFromString"]>
): ProductData | null {
  if (!doc) return null;

  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const image =
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const desc =
    doc.querySelector('meta[property="og:description"]')?.getAttribute("content");

  if (!title || !image) return null;

  return {
    product_title: title,
    product_description: desc || "",
    product_category: inferCategory(title, ""),
    input_images: [image],
  };
}

function extractFromHtml(
  doc: ReturnType<DOMParser["parseFromString"]>,
  url: string
): ProductData | null {
  if (!doc) return null;

  // Try to find product title from common selectors
  const titleEl =
    doc.querySelector("h1.product-name") ||
    doc.querySelector("h1") ||
    doc.querySelector(".product-title");
  const title = titleEl?.textContent?.trim();

  // Try to find product images
  const imgEl =
    doc.querySelector(".product-image img") ||
    doc.querySelector(".main-image img") ||
    doc.querySelector("img[src*='kinclimg']");
  const imgSrc = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src");

  if (!title || !imgSrc) return null;

  return {
    product_title: title,
    product_description: "",
    product_category: extractCategoryFromUrl(url),
    input_images: [toHighResImage(imgSrc)],
  };
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
