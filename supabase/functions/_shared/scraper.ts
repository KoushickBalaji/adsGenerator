// Product data scraper using deno-dom for HTML parsing
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

export type ProductData = {
  product_title: string;
  product_description: string;
  product_category: string;
  input_images: string[];
};

export async function scrapeProduct(url: string): Promise<ProductData> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch product page: ${res.status}`);
  }

  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) throw new Error("Failed to parse HTML");

  // Strategy 1: JSON-LD
  const jsonLd = extractJsonLd(doc);
  if (jsonLd) return jsonLd;

  // Strategy 2: Open Graph tags
  const og = extractOpenGraph(doc);
  if (og) return og;

  throw new Error("Could not extract product details from this URL");
}

function extractJsonLd(doc: ReturnType<DOMParser["parseFromString"]>): ProductData | null {
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

      // Try to infer category from URL or breadcrumb
      const category = inferCategory(product.name || "", product.category || "");

      return {
        product_title: product.name || "",
        product_description: product.description || "",
        product_category: category,
        input_images: images,
      };
    } catch {
      // Invalid JSON-LD, try next
    }
  }
  return null;
}

function extractOpenGraph(doc: ReturnType<DOMParser["parseFromString"]>): ProductData | null {
  if (!doc) return null;

  const title = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const image = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const desc = doc.querySelector('meta[property="og:description"]')?.getAttribute("content");

  if (!title || !image) return null;

  return {
    product_title: title,
    product_description: desc || "",
    product_category: inferCategory(title, ""),
    input_images: [image],
  };
}

function inferCategory(title: string, category: string): string {
  if (category) return category.toLowerCase();

  const lower = title.toLowerCase();
  const categories = ["ring", "necklace", "pendant", "earring", "bracelet", "bangle", "chain", "mangalsutra"];
  for (const cat of categories) {
    if (lower.includes(cat)) return cat;
  }
  return "jewellery";
}
