#!/usr/bin/env node
/**
 * Discover LinkedIn company page URLs using Bing search (no OpenAI API).
 *
 * Writes to `public.company_prompt_profiles.social_links` (merging, not overwriting):
 * - linkedin_company_urls: string[]
 * - linkedin_company_audit: { audited_at, engine, queries_tried, status, error? }
 *
 * Notes:
 * - We do not crawl LinkedIn pages. We only parse public search result links.
 * - This is best-effort; some brands won't have a LinkedIn page or may be hard to disambiguate.
 *
 * Usage:
 *   node scripts/company-linkedin-company-bing.mjs --out-dir scripts/out/linkedin-company
 *   node scripts/company-linkedin-company-bing.mjs --company bluestone --company melorra
 *   node scripts/company-linkedin-company-bing.mjs --concurrency 2 --min-delay-ms 900 --max-delay-ms 1500
 *   node scripts/company-linkedin-company-bing.mjs --force
 *   node scripts/company-linkedin-company-bing.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-linkedin-company-bing.mjs [options]",
      "",
      "Options:",
      "  --company <slug>        Only run for this company (repeatable)",
      "  --companies <path>      Optional JSON mapping: [{ slug, name, website }, ...] (default: scripts/companies.india.json)",
      "  --out-dir <path>        Write per-company JSON outputs",
      "  --concurrency <n>       Parallel companies (default: 2)",
      "  --min-delay-ms <n>      Min delay between Bing requests per worker (default: 900)",
      "  --max-delay-ms <n>      Max delay between Bing requests per worker (default: 1500)",
      "  --max-queries <n>       Max search queries per company (default: 2)",
      "  --force                 Run even if linkedin_company_urls already present",
      "  --dry-run               Do not write to Supabase",
      "  -h, --help              Show help",
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
    companiesPath: "scripts/companies.india.json",
    outDir: null,
    concurrency: 2,
    minDelayMs: 900,
    maxDelayMs: 1500,
    maxQueries: 2,
    force: false,
    dryRun: false,
    market: "en-IN",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim();
      if (slug) args.companySlugs.push(slug.toLowerCase());
      i++;
      continue;
    }
    if (a === "--companies") {
      args.companiesPath = String(argv[i + 1] ?? "").trim() || args.companiesPath;
      i++;
      continue;
    }
    if (a === "--out-dir") {
      args.outDir = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--concurrency") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --concurrency");
      args.concurrency = Math.max(1, Math.min(6, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "--min-delay-ms") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 0) usage("Invalid --min-delay-ms");
      args.minDelayMs = Math.max(0, Math.trunc(n));
      i++;
      continue;
    }
    if (a === "--max-delay-ms") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 0) usage("Invalid --max-delay-ms");
      args.maxDelayMs = Math.max(0, Math.trunc(n));
      i++;
      continue;
    }
    if (a === "--max-queries") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --max-queries");
      args.maxQueries = Math.max(1, Math.min(4, Math.trunc(n)));
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

  if (args.maxDelayMs < args.minDelayMs) usage("--max-delay-ms must be >= --min-delay-ms");
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
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

function readJsonIfExists(filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniq(list) {
  return Array.from(new Set((list || []).map(String).map((s) => s.trim()).filter(Boolean)));
}

function normalizeSlug(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function normalizeLinkedInUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host.endsWith("linkedin.com")) return "";
    if (!u.pathname.toLowerCase().includes("/company/")) return "";
    u.protocol = "https:";
    u.hash = "";
    u.search = "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return "";
  }
}

function getDomainFromWebsite(websiteUrl) {
  try {
    const u = new URL(websiteUrl);
    return u.hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function decodeHtmlAttr(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractHrefs(html) {
  const out = [];
  const re = /<a\s+[^>]*href=\"([^\"]+)\"/gi;
  let m;
  while ((m = re.exec(html))) out.push(decodeHtmlAttr(m[1]));
  return out;
}

function extractLinkedInCompanyUrlsFromHtml(html) {
  const hrefs = extractHrefs(html);
  const out = [];
  for (const href of hrefs) {
    if (!href) continue;
    const direct = normalizeLinkedInUrl(href);
    if (direct) {
      out.push(direct);
      continue;
    }

    // Bing commonly wraps result URLs in /ck/a?u=<base64>
    try {
      const u = new URL(href, "https://www.bing.com");
      const host = u.hostname.replace(/^www\./i, "").toLowerCase();
      if (host.endsWith("bing.com") && u.pathname === "/ck/a" && u.searchParams.has("u")) {
        let enc = u.searchParams.get("u") || "";
        // Often prefixed with "a1"
        if (enc.startsWith("a1")) enc = enc.slice(2);
        const decoded = Buffer.from(enc, "base64").toString("utf8");
        const normalized = normalizeLinkedInUrl(decoded);
        if (normalized) out.push(normalized);
      }
    } catch {
      // ignore
    }
  }
  return uniq(out);
}

async function bingSearchHtml({ query, market, timeoutMs = 25000 }) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=${encodeURIComponent(market)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
    // Basic bot check
    if (/Our systems have detected unusual traffic/i.test(text)) {
      throw new Error("Bing flagged unusual traffic (try lower concurrency / higher delays)");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function buildQueries({ name, domain }) {
  const q1 = `site:linkedin.com/company "${name}" ${domain ? domain : ""} India`.trim();
  const q2 = domain ? `site:linkedin.com/company ${domain}`.trim() : `site:linkedin.com/company "${name}" jewellery India`.trim();
  const q3 = `site:linkedin.com/company "${name}"`.trim();
  return uniq([q1, q2, q3]);
}

async function supabaseListCompanies({ supabaseUrl, supabaseKey }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?select=company_slug,website_url,social_links&order=company_slug.asc`;
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

function shouldSkipExisting({ socialLinks, force }) {
  if (force) return false;
  const social = isRecord(socialLinks) ? socialLinks : {};
  return Array.isArray(social.linkedin_company_urls) && social.linkedin_company_urls.length > 0;
}

async function runPool({ items, concurrency, worker }) {
  const q = items.slice();
  const active = new Set();

  async function runOne() {
    const item = q.shift();
    if (!item) return;
    const p = Promise.resolve()
      .then(() => worker(item))
      .finally(() => active.delete(p));
    active.add(p);
    if (active.size >= concurrency) await Promise.race(active);
    return runOne();
  }

  const starters = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) starters.push(runOne());
  await Promise.all(starters);
  await Promise.all(active);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const companiesJson = readJsonIfExists(args.companiesPath);
  const nameMap = new Map();
  if (Array.isArray(companiesJson)) {
    for (const row of companiesJson) {
      const slug = normalizeSlug(row?.slug);
      const name = String(row?.name || "").trim();
      if (slug && name) nameMap.set(slug, name);
    }
  }

  const only = new Set(args.companySlugs.map(normalizeSlug).filter(Boolean));
  console.log(`Out dir: ${args.outDir ? path.resolve(args.outDir) : "(none)"}`);
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);
  console.log(`Concurrency: ${args.concurrency} (delay ${args.minDelayMs}-${args.maxDelayMs}ms)`);

  const rows = await supabaseListCompanies({ supabaseUrl, supabaseKey });
  const companies = rows
    .map((r) => {
      const slug = normalizeSlug(r?.company_slug);
      const websiteUrl = String(r?.website_url || "").trim();
      const socialLinks = r?.social_links;
      const name = nameMap.get(slug) || slug;
      const domain = websiteUrl ? getDomainFromWebsite(websiteUrl) : "";
      return { slug, name, websiteUrl, domain, socialLinks };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => !shouldSkipExisting({ socialLinks: c.socialLinks, force: args.force }));

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  const startedAt = new Date().toISOString();

  await runPool({
    items: companies,
    concurrency: args.concurrency,
    worker: async (c) => {
      const auditedAt = new Date().toISOString();
      const audit = {
        audited_at: auditedAt,
        engine: "bing",
        queries_tried: [],
        status: "ok",
      };

      try {
        const queries = buildQueries({ name: c.name, domain: c.domain }).slice(0, args.maxQueries);
        const found = [];

        for (const q of queries) {
          audit.queries_tried.push(q);
          const html = await bingSearchHtml({ query: q, market: args.market });
          const urls = extractLinkedInCompanyUrlsFromHtml(html);
          found.push(...urls);
          if (urls.length > 0) break;
          await sleep(randInt(args.minDelayMs, args.maxDelayMs));
        }

        const companyUrls = uniq(found).slice(0, 5);
        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const merged = uniq([...(Array.isArray(current.linkedin_company_urls) ? current.linkedin_company_urls : []), ...companyUrls]);

        const next = {
          ...current,
          linkedin_company_urls: merged,
          linkedin_company_audit: audit,
        };

        if (!next.linkedin_company_url && merged.length > 0) {
          next.linkedin_company_url = merged[0];
        }

        writeOut(args.outDir, `${c.slug}.linkedin-company.json`, {
          company_slug: c.slug,
          company_name: c.name,
          website_url: c.websiteUrl,
          linkedin_company_urls: merged,
          audit,
        });

        if (args.dryRun) {
          console.log(`[dry-run] ${c.slug}: found=${companyUrls.length}`);
          ok += 1;
          return;
        }

        await supabasePatchCompany({
          supabaseUrl,
          supabaseKey,
          slug: c.slug,
          patch: { social_links: next },
        });

        console.log(`[ok] ${c.slug}: found=${companyUrls.length}`);
        ok += 1;
        await sleep(randInt(args.minDelayMs, args.maxDelayMs));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[fail] ${c.slug}: ${msg}`);
        failed += 1;

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const next = {
          ...current,
          linkedin_company_audit: { ...audit, status: "error", error: msg },
        };

        writeOut(args.outDir, `${c.slug}.linkedin-company.json`, {
          company_slug: c.slug,
          company_name: c.name,
          website_url: c.websiteUrl,
          linkedin_company_urls: Array.isArray(current.linkedin_company_urls) ? current.linkedin_company_urls : [],
          audit: next.linkedin_company_audit,
        });

        if (!args.dryRun) {
          try {
            await supabasePatchCompany({
              supabaseUrl,
              supabaseKey,
              slug: c.slug,
              patch: { social_links: next },
            });
          } catch {
            // ignore secondary failures
          }
        }
      }
    },
  });

  const totalEligible = rows
    .map((r) => {
      const slug = normalizeSlug(r?.company_slug);
      const websiteUrl = String(r?.website_url || "").trim();
      return { slug, websiteUrl, socialLinks: r?.social_links };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => !shouldSkipExisting({ socialLinks: c.socialLinks, force: args.force })).length;

  skipped = Math.max(0, totalEligible - ok - failed);
  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed} (started ${startedAt})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
