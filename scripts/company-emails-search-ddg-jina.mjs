#!/usr/bin/env node
/**
 * Find publicly listed contact email addresses using DuckDuckGo search results (fetched via r.jina.ai),
 * scoped to a company's own website via `site:<domain>`.
 *
 * This is a fallback for sites that:
 * - block direct fetches (403/429),
 * - rely heavily on JS rendering,
 * - or do not expose emails on obvious contact pages.
 *
 * Writes to `public.company_prompt_profiles.social_links` (merging, not overwriting):
 * - emails: { general, support, sales, founder, other }   (adds discovered emails)
 * - email_search_audit: { audited_at, engine, queries_tried, found, stored, status, error? }
 *
 * Notes:
 * - Only uses public search results; does not crawl LinkedIn or other gated sources.
 * - Results can include false positives (e.g., vendor/support addresses); treat as starting points.
 *
 * Usage:
 *   node scripts/company-emails-search-ddg-jina.mjs --out-dir scripts/out/email-search
 *   node scripts/company-emails-search-ddg-jina.mjs --company tanishq --company malabar
 *   node scripts/company-emails-search-ddg-jina.mjs --concurrency 1 --min-delay-ms 1500 --max-delay-ms 2500
 *   node scripts/company-emails-search-ddg-jina.mjs --force
 *   node scripts/company-emails-search-ddg-jina.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-emails-search-ddg-jina.mjs [options]",
      "",
      "Options:",
      "  --company <slug>        Only run for this company (repeatable)",
      "  --out-dir <path>        Write per-company JSON outputs",
      "  --concurrency <n>       Parallel companies (default: 1)",
      "  --min-delay-ms <n>      Min delay between requests per worker (default: 1500)",
      "  --max-delay-ms <n>      Max delay between requests per worker (default: 2500)",
      "  --max-queries <n>       Max search queries per company (default: 3)",
      "  --force                 Run even if emails already present",
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
    outDir: null,
    concurrency: 1,
    minDelayMs: 1500,
    maxDelayMs: 2500,
    maxQueries: 3,
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
    if (a === "--concurrency") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --concurrency");
      args.concurrency = Math.max(1, Math.min(4, Math.trunc(n)));
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
      args.maxQueries = Math.max(1, Math.min(6, Math.trunc(n)));
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

function getDomainFromWebsite(websiteUrl) {
  try {
    const u = new URL(websiteUrl);
    return u.hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function getEmailDomain(email) {
  const s = String(email || "").toLowerCase();
  const idx = s.lastIndexOf("@");
  if (idx < 0) return "";
  return s.slice(idx + 1).replace(/^www\./i, "");
}

function isEmailInSiteDomain(email, websiteDomain) {
  const d = getEmailDomain(email);
  const host = String(websiteDomain || "").toLowerCase().replace(/^www\./i, "");
  if (!d || !host) return false;
  return d === host || d.endsWith(`.${host}`);
}

async function fetchDdgMarkdown({ query, timeoutMs = 25000 }) {
  const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const url = `https://r.jina.ai/${ddgUrl}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/plain,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`r.jina.ai HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDdgMarkdownWithRetries({ query, timeoutMs = 25000, maxAttempts = 5 }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchDdgMarkdown({ query, timeoutMs });
    } catch (err) {
      lastErr = err;
      const status = err && typeof err === "object" ? err.status : undefined;
      const isRetryable = status === 429 || status === 502 || status === 503 || status === 504;
      if (!isRetryable || attempt === maxAttempts) throw err;
      const base = status === 429 ? 8000 : 3000;
      const backoff = base * Math.pow(2, attempt - 1);
      const jitter = randInt(250, 1250);
      await sleep(backoff + jitter);
    }
  }
  throw lastErr || new Error("fetch failed");
}

function extractEmails(text) {
  const raw = String(text || "");
  const out = [];
  const re = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
  let m;
  while ((m = re.exec(raw))) out.push(m[0]);
  const blockedDomains = new Set([
    "duckduckgo.com",
    "duck.com",
    "jina.ai",
  ]);
  return uniq(out)
    .map((e) => e.toLowerCase().trim())
    .filter((e) => !e.includes("example.com"))
    .filter((e) => !e.startsWith("noreply@") && !e.startsWith("no-reply@"))
    // Avoid capturing URL-encoded artifacts from the results page itself.
    .filter((e) => !e.includes("%"))
    // Strip phone-number prefixes accidentally glued to the local part.
    .map((e) => {
      const at = e.indexOf("@");
      if (at <= 0) return e;
      const local = e.slice(0, at);
      const domain = e.slice(at + 1);
      const m2 = local.match(/^(\d{9,})([a-z].*)$/i);
      if (m2) return `${m2[2]}@${domain}`;
      return e;
    })
    .filter((e) => {
      const parts = e.split("@");
      const domain = (parts[1] || "").trim();
      if (!domain) return false;
      if (blockedDomains.has(domain)) return false;
      const tld = (domain.split(".").pop() || "").toLowerCase();
      const blockedTlds = new Set([
        "js",
        "css",
        "png",
        "jpg",
        "jpeg",
        "gif",
        "svg",
        "webp",
        "ico",
        "woff",
        "woff2",
        "ttf",
        "eot",
        "map",
        "json",
        "pdf",
        "mp4",
        "webm",
      ]);
      if (!/^[a-z]{2,24}$/.test(tld)) return false;
      if (blockedTlds.has(tld)) return false;

      const local = (parts[0] || "").trim();
      if (/(jane\.?doe|first\.?last|example|test|sample)/i.test(local)) return false;
      if (/(^|\.)dxxx($|\.)/.test(local) || /(x{3,})/.test(local)) return false;
      return true;
    });
}

function stripBlockedEmailsFromBuckets(buckets) {
  const blocked = new Set(["error-lite@duckduckgo.com"]);
  const out = { general: [], support: [], sales: [], founder: [], other: [] };
  for (const k of Object.keys(out)) {
    const v = buckets && Array.isArray(buckets[k]) ? buckets[k] : [];
    out[k] = v.map((e) => String(e || "").toLowerCase().trim()).filter((e) => e && !blocked.has(e));
  }
  return out;
}

function categorizeEmails(list) {
  const emails = uniq(list);
  const buckets = { general: [], support: [], sales: [], founder: [], other: [] };
  for (const e of emails) {
    const local = e.split("@")[0] || "";
    if (/(support|help|care|customer|service)/i.test(local)) buckets.support.push(e);
    else if (/(sales|business|b2b|corporate|orders|order)/i.test(local)) buckets.sales.push(e);
    else if (/(founder|ceo|director|owner|cofounder|co-founder)/i.test(local)) buckets.founder.push(e);
    else if (/(info|hello|contact|enquiry|enquiries|query|reach)/i.test(local)) buckets.general.push(e);
    else buckets.other.push(e);
  }
  return buckets;
}

function buildQueries({ name, domain }) {
  if (!domain) return [];
  const q1 = `site:${domain} email`;
  const q2 = `site:${domain} contact email`;
  const q3 = `site:${domain} \"@\"`;
  const q4 = `${name} ${domain} email`;
  const q5 = `site:${domain} (marketing OR partnerships OR partnership OR collab OR pr OR press) email`;
  const q6 = `site:${domain} partnerships email`;
  const q7 = `site:${domain} marketing email`;
  return uniq([q1, q2, q3, q4, q5, q6, q7]);
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

function isSchemaCacheError(text) {
  const s = String(text || "");
  return /schema cache|could not find|PGRST/i.test(s);
}

async function supabasePatchCompany({ supabaseUrl, supabaseKey, slug, patch, _allowFallback = true }) {
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
  if (!res.ok) {
    const hasExtraKeys = patch && typeof patch === "object" && Object.keys(patch).length > 1;
    const canFallback = _allowFallback && hasExtraKeys && patch && patch.social_links;
    if (canFallback && (res.status === 400 || res.status === 404) && isSchemaCacheError(text)) {
      return supabasePatchCompany({
        supabaseUrl,
        supabaseKey,
        slug,
        patch: { social_links: patch.social_links },
        _allowFallback: false,
      });
    }
    throw new Error(`Supabase PATCH error ${res.status}: ${text}`);
  }
}

function hasAnyEmail(emails) {
  if (!emails || typeof emails !== "object") return false;
  for (const v of Object.values(emails)) {
    if (Array.isArray(v) && v.filter(Boolean).length) return true;
  }
  return false;
}

function shouldSkip({ socialLinks, force }) {
  if (force) return false;
  const social = isRecord(socialLinks) ? socialLinks : {};
  return hasAnyEmail(social.emails);
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
      const domain = websiteUrl ? getDomainFromWebsite(websiteUrl) : "";
      return { slug, websiteUrl, domain, socialLinks };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => !shouldSkip({ socialLinks: c.socialLinks, force: args.force }));

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  await runPool({
    items: companies,
    concurrency: args.concurrency,
    worker: async (c) => {
      const auditedAt = new Date().toISOString();
      const audit = {
        audited_at: auditedAt,
        engine: "ddg_jina",
        queries_tried: [],
        found: 0,
        stored: 0,
        status: "ok",
      };

      try {
        const queries = buildQueries({ name: c.slug, domain: c.domain }).slice(0, args.maxQueries);
        const all = [];

        for (const q of queries) {
          audit.queries_tried.push(q);
          const md = await fetchDdgMarkdownWithRetries({ query: q });
          all.push(...extractEmails(md));
          await sleep(randInt(args.minDelayMs, args.maxDelayMs));
        }

        const found = uniq(all);
        audit.found = found.length;

        const inDomain = found.filter((e) => isEmailInSiteDomain(e, c.domain));
        const toStore = inDomain.length > 0 ? inDomain : found;
        const buckets = categorizeEmails(toStore);
        const stored = Object.values(buckets).flat().length;
        audit.stored = stored;
        audit.found_in_domain = inDomain.length;

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const curEmailsRaw = isRecord(current.emails)
          ? current.emails
          : { general: [], support: [], sales: [], founder: [], other: [] };
        const curEmails = stripBlockedEmailsFromBuckets(curEmailsRaw);
        const nextEmails = {
          general: uniq([...(curEmails.general || []), ...(buckets.general || [])]),
          support: uniq([...(curEmails.support || []), ...(buckets.support || [])]),
          sales: uniq([...(curEmails.sales || []), ...(buckets.sales || [])]),
          founder: uniq([...(curEmails.founder || []), ...(buckets.founder || [])]),
          other: uniq([...(curEmails.other || []), ...(buckets.other || [])]),
        };

        const next = {
          ...current,
          emails: nextEmails,
          email_search_audit: audit,
        };

        writeOut(args.outDir, `${c.slug}.email-search.json`, {
          company_slug: c.slug,
          website_url: c.websiteUrl,
          found,
          found_in_domain: inDomain,
          buckets,
          audit,
        });

        if (args.dryRun) {
          console.log(`[dry-run] ${c.slug}: emails=${stored}`);
          ok += 1;
          return;
        }

        await supabasePatchCompany({
          supabaseUrl,
          supabaseKey,
          slug: c.slug,
          patch: {
            social_links: next,
            emails_general: nextEmails.general,
            emails_support: nextEmails.support,
            emails_sales: nextEmails.sales,
            emails_founder: nextEmails.founder,
            emails_other: nextEmails.other,
          },
        });

        console.log(`[ok] ${c.slug}: emails=${stored}`);
        ok += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[fail] ${c.slug}: ${msg}`);
        failed += 1;

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const next = {
          ...current,
          email_search_audit: { ...audit, status: "error", error: msg },
        };
        writeOut(args.outDir, `${c.slug}.email-search.json`, {
          company_slug: c.slug,
          website_url: c.websiteUrl,
          found: [],
          buckets: { general: [], support: [], sales: [], founder: [], other: [] },
          audit: next.email_search_audit,
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
            // ignore
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
    .filter((c) => !shouldSkip({ socialLinks: c.socialLinks, force: args.force })).length;
  skipped = Math.max(0, totalEligible - ok - failed);

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
