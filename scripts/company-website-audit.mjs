#!/usr/bin/env node
/**
 * Audit each company website in `public.company_prompt_profiles` and backfill:
 * - has_ecommerce
 * - website_notes
 * - scrape_profile (JSONB)
 *
 * This is intentionally heuristic (HTML-only). It is meant to:
 * - confirm the site is shoppable (best-effort)
 * - capture a representative product URL example
 * - record which extraction strategy is likely to work (JSON-LD vs OG tags)
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-website-audit.mjs [options]",
      "",
      "Options:",
      "  --company <slug>   Only run for this company (repeatable)",
      "  --out-dir <path>   Write per-company audit JSON outputs",
      "  --force            Overwrite existing website_notes/has_ecommerce/scrape_profile",
      "  --dry-run          Do not write to Supabase",
      "  -h, --help         Show help",
      "",
      "Env vars (or .env.local):",
      "  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    companySlugs: [],
    outDir: null,
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim();
      if (slug) args.companySlugs.push(slug.toLowerCase());
      i++;
      continue;
    }
    if (a === "--out-dir") {
      args.outDir = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--force") {
      args.force = true;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "-h" || a === "--help") usage();
    usage(`Unknown argument: ${a}`);
  }

  return args;
}

function readDotEnvLocal() {
  const filePath = path.resolve(".env.local");
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function getRequiredEnv(dotEnv, key) {
  const v = process.env[key] || dotEnv[key];
  if (!v) usage(`Missing ${key} (set env var or add to .env.local)`);
  return v;
}

function ensureDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(path.resolve(dirPath), { recursive: true });
}

function writeOut(outDir, filename, json) {
  if (!outDir) return;
  ensureDir(outDir);
  fs.writeFileSync(path.join(path.resolve(outDir), filename), JSON.stringify(json, null, 2));
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchText(url, { timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: controller.signal });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      contentType: res.headers.get("content-type") || "",
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function stripTags(htmlLike) {
  return String(htmlLike || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1]).slice(0, 200) : "";
}

function extractMetaDescription(html) {
  const m =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i.exec(html);
  return m ? stripTags(m[1]).slice(0, 300) : "";
}

function extractH1(html) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? stripTags(m[1]).slice(0, 200) : "";
}

function extractH2(html) {
  const m = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(html);
  return m ? stripTags(m[1]).slice(0, 200) : "";
}

function extractHrefs(html) {
  const out = [];
  const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = (m[1] || m[2] || m[3] || "").trim();
    if (!href) continue;
    out.push(href);
    if (out.length > 5000) break; // hard cap
  }
  return out;
}

function normalizeUrl(maybeUrl, baseUrl) {
  let raw = String(maybeUrl || "").trim();
  if (!raw) return null;
  // Some sites embed quotes inside href values (e.g. "\"/products/...\"").
  raw = raw.replace(/^[\"']+/, "").replace(/[\"']+$/, "").trim();
  if (raw.startsWith("#")) return null;
  if (raw.toLowerCase().startsWith("javascript:")) return null;
  if (raw.toLowerCase().startsWith("mailto:")) return null;
  if (raw.toLowerCase().startsWith("tel:")) return null;

  try {
    if (raw.startsWith("//")) {
      // If this looks like a protocol-relative DOMAIN, keep it as such.
      // Otherwise treat it as a path (some buggy templates emit "//products/...").
      const after = raw.slice(2);
      const hostCandidate = after.split("/")[0] || "";
      const looksLikeDomain = /\./.test(hostCandidate);
      if (looksLikeDomain) return new URL(`https:${raw}`).toString();
      raw = `/${after}`;
    }
    // Collapse accidental multiple leading slashes in paths.
    if (raw.startsWith("///")) raw = raw.replace(/^\/+/, "/");
    // Collapse accidental double slashes in paths (but never touch protocol strings like https://).
    if (raw.startsWith("/")) raw = raw.replace(/\/{2,}/g, "/");
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^www\./, "");
}

function isSameSite(urlStr, siteUrlStr) {
  try {
    const u = new URL(urlStr);
    const s = new URL(siteUrlStr);
    const uh = normalizeHostname(u.hostname);
    const sh = normalizeHostname(s.hostname);
    return uh === sh || uh.endsWith(`.${sh}`);
  } catch {
    return false;
  }
}

function uniqueStrings(values) {
  return Array.from(new Set(values));
}

function scoreProductUrl(urlStr, companySlug) {
  const u = String(urlStr || "");
  const lower = u.toLowerCase();
  if (lower.includes("%22") || lower.includes("\"")) return 0;

  // Avoid account/auth and non-product pages
  if (/(\/account|\/login|\/signup|\/register|\/pages\/|\/blogs\/|\/blog\/|\/policies\/|\/policy\/|\/privacy|\/terms)/i.test(lower)) {
    return 0;
  }

  // BlueStone specific: /...~12345.html
  if (companySlug === "bluestone" && /~\d+\.html(\b|$)/i.test(lower)) return 100;

  let score = 0;
  if (lower.includes("/products/")) score = Math.max(score, 90);
  if (lower.includes("/product/")) score = Math.max(score, 80);
  // Some custom stores embed product identifiers as "..._product_12345_...".
  if (/_product_\d+/i.test(lower) || /product_\d+/i.test(lower)) score = Math.max(score, 70);
  if (lower.includes("/collections/") && lower.includes("/products/")) score = Math.max(score, 85);
  if (/[?&]variant=\d+/i.test(lower)) score = Math.max(score, 75);
  if (/(\/p\/|\/prod\/)/i.test(lower)) score = Math.max(score, 70);
  if (/\/buy\b/i.test(lower)) score = Math.max(score, 60);
  return score;
}

function findCartSignals(html) {
  const lower = html.toLowerCase();
  const hasCartPath =
    /(href|action)\s*=\s*["'][^"']*\/cart(?:\b|\/)/i.test(html) ||
    /\/cart\.js\b/i.test(lower) ||
    /\/cart\/add\b/i.test(lower) ||
    /cart\/add\.js\b/i.test(lower);

  const hasCheckoutPath =
    /(href|action)\s*=\s*["'][^"']*\/checkout(?:\b|\/)/i.test(html) ||
    /\/checkout\b/i.test(lower);

  const hasAddToCartAction =
    /add-to-cart\b/i.test(lower) ||
    /add_to_cart\b/i.test(lower) ||
    /add-to-bag\b/i.test(lower) ||
    /add_to_bag\b/i.test(lower) ||
    /wc-ajax=add_to_cart\b/i.test(lower) ||
    /\/cart\/add\b/i.test(lower);

  const hasAddToCartText = /(add\s*to\s*(cart|bag|basket))/i.test(html);

  return {
    hasCartLink: hasCartPath,
    hasCheckout: hasCheckoutPath,
    hasAddToCartText,
    hasBuyNowText: /buy\s*now/i.test(html),
    hasAddToCartAction,
  };
}

function detectPlatform(html) {
  const lower = html.toLowerCase();
  const shopify =
    lower.includes("cdn.shopify.com") ||
    /meta\s+name=["']shopify-checkout-api-token["']/i.test(html) ||
    /\bshopify\b/i.test(html);
  const woocommerce = /\bwoocommerce\b/i.test(html) || /wp-content\/plugins\/woocommerce/i.test(lower);
  return {
    shopify,
    woocommerce,
  };
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = (m[1] || "").trim();
    if (raw) blocks.push(raw);
    if (blocks.length > 50) break;
  }
  return blocks;
}

function jsonLdContainsProduct(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(jsonLdContainsProduct);
  if (typeof value === "object") {
    const t = value["@type"];
    if (typeof t === "string" && t.toLowerCase() === "product") return true;
    if (Array.isArray(t) && t.some((x) => String(x).toLowerCase() === "product")) return true;
    if (value["@graph"] && jsonLdContainsProduct(value["@graph"])) return true;
    // Some sites embed product under mainEntity
    if (value.mainEntity && jsonLdContainsProduct(value.mainEntity)) return true;
  }
  return false;
}

function hasJsonLdProduct(html) {
  const blocks = extractJsonLdBlocks(html);
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw);
      if (jsonLdContainsProduct(parsed)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function hasOgTags(html) {
  return /property=["']og:title["']/i.test(html) && /property=["']og:image["']/i.test(html);
}

async function tryShopifyProductsJson(siteUrl) {
  try {
    const origin = new URL(siteUrl).origin;
    const res = await fetch(`${origin}/products.json?limit=1`, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json,*/*" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const json = await res.json();
    const products = json?.products;
    if (!Array.isArray(products) || products.length === 0) return null;
    const handle = products[0]?.handle;
    if (!handle || typeof handle !== "string") return null;
    return `${origin}/products/${handle}`;
  } catch {
    return null;
  }
}

async function discoverRepresentativeProductCandidates({ companySlug, websiteUrl, homepageHtml }) {
  const base = websiteUrl;
  const candidates = [];

  // 1) Prefer explicit product-looking links on the homepage.
  {
    const hrefs = extractHrefs(homepageHtml);
    const normalized = hrefs
      .map((h) => normalizeUrl(h, base))
      .filter(Boolean)
      .filter((u) => isSameSite(u, base));

    const scored = uniqueStrings(normalized)
      .map((u) => ({ url: u, score: scoreProductUrl(u, companySlug), discoveredBy: "homepage_links" }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    candidates.push(...scored);
  }

  // 1b) Fallback: search raw HTML for product-looking URL strings (not necessarily in <a href>).
  {
    const rawUrlMatches = Array.from(
      homepageHtml.matchAll(/https?:\/\/[^\s"'<>]+/gi),
      (m) => String(m[0] || "")
    );
    const rawPathMatches = Array.from(
      homepageHtml.matchAll(/\/(?:products|product)\/[a-z0-9][a-z0-9\-_/]+/gi),
      (m) => String(m[0] || "")
    );
    const rawCandidates = uniqueStrings([...rawUrlMatches, ...rawPathMatches])
      .map((u) => normalizeUrl(u, base))
      .filter(Boolean)
      .filter((u) => isSameSite(u, base));

    const rawScored = uniqueStrings(rawCandidates)
      .map((u) => ({ url: u, score: scoreProductUrl(u, companySlug), discoveredBy: "html_string_match" }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    candidates.push(...rawScored);
  }

  // 2) Shopify fallback: try public products.json.
  {
    const shopifyUrl = await tryShopifyProductsJson(websiteUrl);
    if (shopifyUrl) {
      candidates.push({ url: shopifyUrl, score: 95, discoveredBy: "shopify_products_json" });
    }
  }

  // 3) Sitemap fallback: many stores publish product URLs in sitemap.
  {
    const sitemapUrl = await discoverFromSitemap({ companySlug, websiteUrl });
    if (sitemapUrl) {
      candidates.push({ url: sitemapUrl, score: 88, discoveredBy: "sitemap" });
    }
  }

  // Dedupe, keeping the highest score (and earliest source).
  const byUrl = new Map();
  for (const c of candidates) {
    const key = String(c.url || "").trim();
    if (!key) continue;
    const prev = byUrl.get(key);
    if (!prev || (c.score ?? 0) > (prev.score ?? 0)) byUrl.set(key, c);
  }

  return Array.from(byUrl.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

async function discoverFromSitemap({ companySlug, websiteUrl }) {
  let origin;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    return null;
  }

  const rootSitemapCandidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
  ];

  for (const root of rootSitemapCandidates) {
    try {
      const res = await fetchText(root, { timeoutMs: 25000 });
      if (!res.ok) continue;
      const xml = res.text || "";
      const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/gi), (m) => String(m[1] || "").trim())
        .filter(Boolean)
        .slice(0, 1500);
      if (locs.length === 0) continue;

      const isIndex = /<sitemapindex\b/i.test(xml);
      if (!isIndex) {
        const best = pickBestProductUrl({ companySlug, websiteUrl, candidates: locs });
        if (best) return best;
        continue;
      }

      const prioritized = locs
        .filter((u) => /\.xml/i.test(u))
        .sort((a, b) => scoreSitemapUrl(b) - scoreSitemapUrl(a))
        .slice(0, 4);

      for (const child of prioritized) {
        const childRes = await fetchText(child, { timeoutMs: 35000 });
        if (!childRes.ok) continue;
        const childXml = childRes.text || "";
        const childLocs = Array.from(childXml.matchAll(/<loc>([^<]+)<\/loc>/gi), (m) =>
          String(m[1] || "").trim()
        )
          .filter(Boolean)
          .slice(0, 3000);
        if (childLocs.length === 0) continue;
        const best = pickBestProductUrl({ companySlug, websiteUrl, candidates: childLocs });
        if (best) return best;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function scoreSitemapUrl(urlStr) {
  const u = String(urlStr || "").toLowerCase();
  if (u.includes("product")) return 20;
  if (u.includes("products")) return 20;
  if (u.includes("shop")) return 10;
  return 0;
}

function pickBestProductUrl({ companySlug, websiteUrl, candidates }) {
  const base = websiteUrl;
  const normalized = candidates
    .map((u) => normalizeUrl(u, base))
    .filter(Boolean)
    .filter((u) => isSameSite(u, base));
  const scored = uniqueStrings(normalized)
    .map((u) => ({ url: u, score: scoreProductUrl(u, companySlug) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length > 0 ? scored[0].url : null;
}

function buildWebsiteNotes({ websiteUrl, homepage, productPage, hasEcommerce, strategy }) {
  const parts = [];
  parts.push(`Website: ${websiteUrl}`);
  if (homepage?.title) parts.push(`Homepage title: ${homepage.title}`);
  if (homepage?.description) parts.push(`Homepage description: ${homepage.description}`);
  if (homepage?.h1) parts.push(`Homepage H1: ${homepage.h1}`);
  if (homepage?.h2) parts.push(`Homepage H2: ${homepage.h2}`);
  parts.push(`E-commerce: ${hasEcommerce === true ? "yes" : hasEcommerce === false ? "no" : "unknown"}`);
  if (productPage?.url) parts.push(`Product URL example: ${productPage.url}`);
  if (strategy) parts.push(`Scrape strategy: ${strategy}`);
  return parts.join("\n");
}

async function supabaseListCompanies({ supabaseUrl, supabaseKey }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?select=company_slug,website_url,has_ecommerce,website_notes,scrape_profile&order=company_slug.asc`;

  const res = await fetch(url, {
    method: "GET",
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET error ${res.status}: ${text}`);
  const json = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(json)) throw new Error("Supabase GET did not return an array");
  return json;
}

async function supabasePatchCompany({ supabaseUrl, supabaseKey, slug, patch }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?company_slug=eq.${encodeURIComponent(slug)}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH error ${res.status}: ${text}`);
}

function isEmptyJsonObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const only = new Set(args.companySlugs);
  console.log(`Out dir: ${args.outDir ? path.resolve(args.outDir) : "(none)"}`);
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);

  const companies = await supabaseListCompanies({ supabaseUrl, supabaseKey });
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of companies) {
    const slug = String(row?.company_slug || "").trim().toLowerCase();
    if (!slug) continue;
    if (only.size > 0 && !only.has(slug)) continue;

    const websiteUrl = typeof row?.website_url === "string" ? row.website_url.trim() : "";
    if (!websiteUrl) {
      console.log(`\n[skip] ${slug}: no website_url`);
      skipped += 1;
      continue;
    }

    const hasExisting =
      (!isEmptyJsonObject(row?.scrape_profile) && row?.scrape_profile != null) ||
      (typeof row?.website_notes === "string" && row.website_notes.trim()) ||
      typeof row?.has_ecommerce === "boolean";

    if (hasExisting && !args.force) {
      console.log(`\n[skip] ${slug}: already populated (use --force to overwrite)`);
      skipped += 1;
      continue;
    }

    console.log(`\n=== ${slug} ===`);

    try {
      const homepageRes = await fetchText(websiteUrl);
      const homepageHtml = homepageRes.text || "";
      const homepage = {
        finalUrl: homepageRes.url,
        status: homepageRes.status,
        contentType: homepageRes.contentType,
        title: extractTitle(homepageHtml),
        description: extractMetaDescription(homepageHtml),
        h1: extractH1(homepageHtml),
        h2: extractH2(homepageHtml),
        signals: {
          ...findCartSignals(homepageHtml),
          ...detectPlatform(homepageHtml),
        },
      };

      const homepageIsHtml = String(homepageRes.contentType || "")
        .toLowerCase()
        .includes("text/html");

      // Some sites block non-browser traffic (403/402/429) or return non-HTML. In that case,
      // store a minimal audit record so the table stays populated and we can skip future runs.
      if (!homepageRes.ok || !homepageIsHtml) {
        const scrapeProfile = {
          adapter:
            slug === "bluestone"
              ? "bluestone"
              : homepage.signals.shopify
                ? "shopify"
                : "generic",
          platform_hint: homepage.signals.shopify ? "shopify" : "unknown",
          homepage_url_final: homepage.finalUrl,
          discovered_product_url: null,
          discovered_by: null,
          candidate_product_urls: [],
          strategy: {
            prefer: "json_ld_then_og",
            detected: "blocked_or_non_html",
          },
          signals: {
            homepage: homepage.signals,
          },
          audit_error: {
            kind: "homepage_blocked_or_non_html",
            status: homepageRes.status,
            content_type: homepageRes.contentType,
          },
          audited_at: new Date().toISOString(),
        };

        const websiteNotes = buildWebsiteNotes({
          websiteUrl,
          homepage,
          productPage: null,
          hasEcommerce: null,
          strategy: "blocked_or_non_html",
        });

        const audit = {
          company_slug: slug,
          website_url: websiteUrl,
          has_ecommerce: null,
          website_notes: websiteNotes,
          scrape_profile: scrapeProfile,
          homepage,
          product_page: null,
          audited_at: new Date().toISOString(),
        };

        writeOut(args.outDir, `${slug}.audit.json`, audit);

        if (args.dryRun) {
          console.log("[dry-run] Would update has_ecommerce, website_notes, scrape_profile.");
          ok += 1;
          continue;
        }

        await supabasePatchCompany({
          supabaseUrl,
          supabaseKey,
          slug,
          patch: {
            has_ecommerce: null,
            website_notes: websiteNotes,
            scrape_profile: scrapeProfile,
          },
        });

        console.log("[ok] Recorded blocked homepage audit (manual check needed).");
        ok += 1;
        continue;
      }

      const candidateProductUrls = await discoverRepresentativeProductCandidates({
        companySlug: slug,
        websiteUrl,
        homepageHtml,
      });

      let discovered = null;
      let productRes = null;
      for (const candidate of candidateProductUrls.slice(0, 6)) {
        const res = await fetchText(candidate.url, { timeoutMs: 20000 });
        if (!res.ok) continue;
        if (!String(res.contentType || "").toLowerCase().includes("text/html")) continue;
        discovered = { url: res.url, discoveredBy: candidate.discoveredBy, requestedUrl: candidate.url };
        productRes = res;
        break;
      }

      const scrapeProfile = {
        adapter:
          slug === "bluestone"
            ? "bluestone"
            : homepage.signals.shopify
              ? "shopify"
              : "generic",
        platform_hint: homepage.signals.shopify ? "shopify" : "unknown",
        homepage_url_final: homepage.finalUrl,
        discovered_product_url: discovered?.url || null,
        discovered_by: discovered?.discoveredBy || null,
        candidate_product_urls: candidateProductUrls.map((c) => c.url).slice(0, 10),
        strategy: {
          prefer: "json_ld_then_og",
        },
        signals: {
          homepage: homepage.signals,
        },
      };

      let productPage = null;
      let strategy = "unknown";
      let hasEcommerce = null;

      if (discovered?.url && productRes) {
        const productHtml = productRes.text;
        const productSignals = {
          ...findCartSignals(productHtml),
          ...detectPlatform(productHtml),
          json_ld_product: hasJsonLdProduct(productHtml),
          og_tags: hasOgTags(productHtml),
        };

        productPage = {
          url: productRes.url,
          status: productRes.status,
          contentType: productRes.contentType,
          title: extractTitle(productHtml),
          signals: productSignals,
        };

        scrapeProfile.platform_hint =
          productSignals.shopify ? "shopify" : scrapeProfile.platform_hint;
        scrapeProfile.signals.product_page = productSignals;
        if (slug !== "bluestone" && productSignals.shopify) {
          scrapeProfile.adapter = "shopify";
        }

        if (productSignals.json_ld_product) strategy = "json_ld_product";
        else if (productSignals.og_tags) strategy = "og_tags";
        else strategy = "selectors_needed";

        // Determine if the site is actually shoppable (best-effort heuristic).
        if (productSignals.hasAddToCartText || productSignals.hasBuyNowText || productSignals.hasAddToCartAction) {
          hasEcommerce = true;
        } else if (productSignals.shopify && (homepage.signals.hasCartLink || homepage.signals.hasCheckout)) {
          hasEcommerce = true;
        } else if (productSignals.json_ld_product && homepage.signals.hasCartLink) {
          hasEcommerce = true;
        } else {
          hasEcommerce = false;
        }
      } else {
        // If we couldn't find a product page, infer from homepage only.
        if (homepage.signals.shopify && (homepage.signals.hasCartLink || homepage.signals.hasCheckout)) {
          hasEcommerce = true;
        } else if (homepage.signals.hasAddToCartText || homepage.signals.hasBuyNowText) {
          hasEcommerce = true;
        } else if (homepage.signals.hasCartLink) {
          hasEcommerce = true;
        } else {
          hasEcommerce = false;
        }

        strategy = "unknown";
      }

      scrapeProfile.strategy.detected = strategy;
      const websiteNotes = buildWebsiteNotes({
        websiteUrl,
        homepage,
        productPage,
        hasEcommerce,
        strategy,
      });

      const audit = {
        company_slug: slug,
        website_url: websiteUrl,
        has_ecommerce: hasEcommerce,
        website_notes: websiteNotes,
        scrape_profile: scrapeProfile,
        homepage,
        product_page: productPage,
        audited_at: new Date().toISOString(),
      };

      writeOut(args.outDir, `${slug}.audit.json`, audit);

      if (args.dryRun) {
        console.log("[dry-run] Would update has_ecommerce, website_notes, scrape_profile.");
        ok += 1;
        continue;
      }

      await supabasePatchCompany({
        supabaseUrl,
        supabaseKey,
        slug,
        patch: {
          has_ecommerce: hasEcommerce,
          website_notes: websiteNotes,
          scrape_profile: scrapeProfile,
        },
      });

      console.log("[ok] Updated company_prompt_profiles.");
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[warn] ${slug}: ${msg}`);

      const nowIso = new Date().toISOString();
      const websiteNotes =
        `Automated website audit failed (${nowIso}). ` +
        `Manual check needed. Error: ${msg}`;

      const scrapeProfile = {
        adapter: slug === "bluestone" ? "bluestone" : "generic",
        platform_hint: "unknown",
        homepage_url_final: websiteUrl,
        discovered_product_url: null,
        discovered_by: null,
        candidate_product_urls: [],
        strategy: {
          prefer: "json_ld_then_og",
          detected: "audit_failed",
        },
        signals: {},
        audit_error: { kind: "fetch_error", message: msg },
        audited_at: nowIso,
      };

      const audit = {
        company_slug: slug,
        website_url: websiteUrl,
        has_ecommerce: null,
        website_notes: websiteNotes,
        scrape_profile: scrapeProfile,
        homepage: null,
        product_page: null,
        audited_at: nowIso,
      };

      writeOut(args.outDir, `${slug}.audit.json`, audit);

      if (args.dryRun) {
        console.log("[dry-run] Would update has_ecommerce, website_notes, scrape_profile (audit failed).");
        ok += 1;
        continue;
      }

      try {
        await supabasePatchCompany({
          supabaseUrl,
          supabaseKey,
          slug,
          patch: {
            has_ecommerce: null,
            website_notes: websiteNotes,
            scrape_profile: scrapeProfile,
          },
        });
        console.log("[ok] Recorded audit failure to company_prompt_profiles.");
        ok += 1;
      } catch (patchErr) {
        const patchMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
        console.warn(`[fail] ${slug}: also failed to patch Supabase: ${patchMsg}`);
        failed += 1;
      }
    }
  }

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
