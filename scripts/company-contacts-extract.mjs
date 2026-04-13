#!/usr/bin/env node
/**
 * Extract publicly listed contact emails from each company's website and store them on
 * `public.company_prompt_profiles.social_links`.
 *
 * Why social_links?
 * - It's already a JSONB field intended for outreach metadata.
 * - Avoids requiring a DB migration for contact columns.
 *
 * What it does:
 * - Fetches homepage + likely contact/about pages (HTML only)
 * - Extracts emails (mailto + plain text + common obfuscations)
 * - Categorizes into general / support / sales / founder-ish (heuristic)
 * - Updates `social_links.emails` + `social_links.contact_pages` + `social_links.contact_audit`
 *
 * Limitations:
 * - Some sites block bot fetches (403/402/429) or have TLS issues; those are recorded as errors
 *   and should be verified manually in a real browser.
 * - We do NOT attempt to retrieve “incorporation emails” from MCA filings.
 *
 * Requirements:
 * - Node.js 18+ (Node 20+ recommended)
 * - Env vars (or .env.local):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node scripts/company-contacts-extract.mjs --out-dir scripts/out/contacts
 *   node scripts/company-contacts-extract.mjs --company giva --company bluestone
 *   node scripts/company-contacts-extract.mjs --concurrency 4
 *   node scripts/company-contacts-extract.mjs --force
 *   node scripts/company-contacts-extract.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-contacts-extract.mjs [options]",
      "",
      "Options:",
      "  --company <slug>        Only run for this company (repeatable)",
      "  --out-dir <path>        Write per-company contact JSON outputs",
      "  --concurrency <n>       Parallel fetches (default: 4)",
      "  --force                Overwrite existing social_links.emails (default: skip if present)",
      "  --dry-run              Do not write to Supabase",
      "  -h, --help             Show help",
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
    concurrency: 4,
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
      args.concurrency = Math.max(1, Math.min(12, Math.trunc(n)));
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

async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
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

function decodeEntities(s) {
  // Keep small + dependency-free.
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeEmail(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let out = s
    .replace(/^mailto:/i, "")
    .replace(/\?.*$/, "")
    .trim()
    .toLowerCase();

  // Trim common junk wrappers / encodings.
  out = out.replace(/^u003e/i, "").replace(/^u003c/i, "");
  out = out.replace(/^[<>"'`]+/, "").replace(/[<>"'`,;:.]+$/, "");

  // If a phone number got concatenated into the local part (common in footer text), strip it.
  // Example: "919035454656contact@domain.com" -> "contact@domain.com"
  const at = out.indexOf("@");
  if (at > 0) {
    const local = out.slice(0, at);
    const domain = out.slice(at + 1);
    const m = local.match(/^(\d{9,})([a-z].*)$/i);
    if (m) out = `${m[2]}@${domain}`;
  }

  return out;
}

function isProbablyEmail(s) {
  if (!s) return false;
  if (s.length > 120) return false;
  if (!s.includes("@")) return false;
  if (/\s/.test(s)) return false;
  const parts = s.split("@");
  if (parts.length !== 2) return false;
  const local = parts[0] || "";
  const domain = parts[1] || "";
  if (!local || !domain) return false;

  // Avoid false positives like "user@localhost"
  const tld = (domain.split(".").pop() || "").toLowerCase();
  if (!/^[a-z]{2,24}$/.test(tld)) return false;
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
  if (blockedTlds.has(tld)) return false;

  // Basic domain sanity.
  if (!/^[a-z0-9.-]+$/.test(domain)) return false;
  if (!domain.includes(".")) return false;

  // Filter obvious placeholders.
  const lowerLocal = local.toLowerCase();
  if (/(jane\.?doe|first\.?last|example|test|sample)/i.test(lowerLocal)) return false;
  if (/(^|\.)dxxx($|\.)/.test(lowerLocal) || /(x{3,})/.test(lowerLocal)) return false;

  return true;
}

function extractEmailsFromText(text) {
  const out = [];
  const raw = decodeEntities(String(text || ""));
  const normalized = raw
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".")
    .replace(/%40/gi, "@")
    .replace(/%2E/gi, ".")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  const re = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
  let m;
  while ((m = re.exec(normalized))) {
    out.push(m[0]);
    if (out.length > 50) break;
  }
  const cleaned = out.map(normalizeEmail).filter(isProbablyEmail);
  return Array.from(new Set(cleaned));
}

function extractContactPageLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = String(m[1] || m[2] || m[3] || "").trim();
    if (!href) continue;
    if (href.startsWith("#") || href.startsWith("javascript:")) continue;
    const text = href.toLowerCase();
    if (
      !/contact|about|team|founder|co-founder|ceo|leadership|our-story|story|support|help|customer|reach|connect|wholesale|press|media/i.test(
        text
      )
    ) {
      continue;
    }
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= 12) break;
  }
  return out;
}

function getHostname(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase();
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

function isEmailInSiteDomain(email, websiteUrl) {
  const host = getHostname(websiteUrl);
  if (!host) return false;
  const d = getEmailDomain(email);
  if (!d) return false;
  return d === host || d.endsWith(`.${host}`);
}

function buildGuessedPaths(baseUrl) {
  const bases = [
    "/contact",
    "/contact-us",
    "/contactus",
    "/pages/contact",
    "/pages/contact-us",
    "/pages/contactus",
    "/pages/reach-us",
    "/pages/get-in-touch",
    "/pages/customer-care",
    "/pages/help",
    "/pages/support",
    "/support",
    "/help",
    "/about",
    "/about-us",
    "/pages/about",
    "/pages/about-us",
    "/pages/our-story",
    "/our-story",
    "/pages/team",
    "/team",
  ];
  const policies = [
    "/policies/privacy-policy",
    "/policies/terms-of-service",
    "/policies/shipping-policy",
    "/policies/refund-policy",
    "/privacy-policy",
    "/terms-and-conditions",
    "/terms-of-service",
    "/shipping-policy",
    "/return-policy",
    "/refund-policy",
  ];
  const out = [];
  for (const p of [...bases, ...policies]) {
    try {
      out.push(new URL(p, baseUrl).toString());
    } catch {
      // ignore
    }
  }
  return out;
}

function mergeEmails(existing, incoming) {
  const set = new Set([...(existing || []), ...(incoming || [])].map((s) => normalizeEmail(s)).filter(isProbablyEmail));
  return Array.from(set).sort();
}

function mergeUniqueStrings(existing, incoming) {
  const set = new Set(
    [...(existing || []), ...(incoming || [])]
      .map((s) => String(s || "").trim())
      .filter(Boolean)
  );
  return Array.from(set);
}

function categorizeEmails({ emails, pageText }) {
  const categories = {
    general: [],
    support: [],
    sales: [],
    founder: [],
    other: [],
  };

  const lowerPage = String(pageText || "").toLowerCase();
  const founderContext = /founder|co-founder|ceo|owner|director|leadership/i.test(lowerPage);

  for (const email of emails) {
    const local = email.split("@")[0] || "";
    const lower = email.toLowerCase();
    if (/support|care|help|customercare|customer\-care|service/i.test(lower) || /support|care|help/i.test(local)) {
      categories.support.push(email);
    } else if (/sales|business|wholesale|collab|partnership|press|pr|media/i.test(lower) || /sales|biz|press|pr/i.test(local)) {
      categories.sales.push(email);
    } else if (founderContext && /founder|ceo|owner|director|md|cofounder|co-founder/i.test(lowerPage)) {
      // Only tag as founder-ish when the page itself is founder/leadership related.
      categories.founder.push(email);
    } else {
      categories.general.push(email);
    }
  }

  for (const k of Object.keys(categories)) {
    categories[k] = mergeEmails([], categories[k]);
  }
  return categories;
}

function categorizeEmailsWithContext(emailMentions) {
  const categories = {
    general: [],
    support: [],
    sales: [],
    founder: [],
    other: [],
  };

  const classify = ({ email, pageUrl, pageText }) => {
    const lowerEmail = String(email || "").toLowerCase();
    const local = lowerEmail.split("@")[0] || "";
    const lowerUrl = String(pageUrl || "").toLowerCase();
    const lowerText = String(pageText || "").toLowerCase();

    const isFounderContext =
      /founder|co-founder|ceo|leadership|team|about|our-story|story/i.test(lowerUrl) ||
      /founder|co-founder|ceo|owner|director|leadership/i.test(lowerText);

    const isSalesContext =
      /wholesale|sales|business|collab|partner|press|media|pr/i.test(lowerUrl) ||
      /wholesale|sales|business|collab|partnership|press|media|pr/i.test(lowerText) ||
      /sales|business|wholesale|collab|partner|press|media|pr/i.test(lowerEmail) ||
      /sales|biz|press|pr|wholesale/i.test(local);

    const isSupportContext =
      /support|help|customer|care|service|returns|refund|shipping|delivery/i.test(lowerUrl) ||
      /support|help|customer\s*care|customer\s*service|returns|refund|shipping|delivery/i.test(lowerText) ||
      /support|care|help|customercare|customer\-care|service/i.test(lowerEmail) ||
      /support|care|help|service/i.test(local);

    if (isFounderContext) return "founder";
    if (isSalesContext) return "sales";
    if (isSupportContext) return "support";
    return "general";
  };

  for (const mention of emailMentions) {
    const bucket = classify(mention);
    categories[bucket].push(mention.email);
  }

  for (const k of Object.keys(categories)) {
    categories[k] = mergeEmails([], categories[k]);
  }

  const used = new Set([
    ...categories.founder,
    ...categories.sales,
    ...categories.support,
  ]);
  categories.general = categories.general.filter((e) => !used.has(e));

  return categories;
}

function extractSocialLinksFromHtml(html, baseUrl) {
  const out = {
    instagram: [],
    linkedin: [],
    facebook: [],
    youtube: [],
    x: [],
    tiktok: [],
    whatsapp: [],
  };
  const seen = new Set();
  const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = String(m[1] || m[2] || m[3] || "").trim();
    if (!href) continue;
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const lower = abs.toLowerCase();
    if (seen.has(abs)) continue;
    if (/instagram\.com\//i.test(lower)) out.instagram.push(abs);
    else if (/linkedin\.com\//i.test(lower)) out.linkedin.push(abs);
    else if (/facebook\.com\//i.test(lower)) out.facebook.push(abs);
    else if (/youtube\.com\//i.test(lower) || /youtu\.be\//i.test(lower)) out.youtube.push(abs);
    else if (/x\.com\//i.test(lower) || /twitter\.com\//i.test(lower)) out.x.push(abs);
    else if (/tiktok\.com\//i.test(lower)) out.tiktok.push(abs);
    else if (/wa\.me\//i.test(lower) || /api\.whatsapp\.com\//i.test(lower)) out.whatsapp.push(abs);
    else continue;
    seen.add(abs);
    if (seen.size > 30) break;
  }

  for (const k of Object.keys(out)) {
    out[k] = Array.from(new Set(out[k])).slice(0, 6);
    if (out[k].length === 0) delete out[k];
  }
  return out;
}

function shouldSkipExistingEmails(socialLinks) {
  if (!socialLinks || typeof socialLinks !== "object" || Array.isArray(socialLinks)) return false;
  const emails = socialLinks.emails;
  if (!emails || typeof emails !== "object" || Array.isArray(emails)) return false;
  const any =
    (Array.isArray(emails.general) && emails.general.length) ||
    (Array.isArray(emails.support) && emails.support.length) ||
    (Array.isArray(emails.sales) && emails.sales.length) ||
    (Array.isArray(emails.founder) && emails.founder.length) ||
    (Array.isArray(emails.other) && emails.other.length);
  return Boolean(any);
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

async function extractForCompany({ slug, websiteUrl }) {
  const startedAt = new Date().toISOString();
  const pagesTried = [];
  const pagesOk = [];
  const emailsByPage = {};
  const pageTextByUrl = {};
  const socialByUrl = {};

  const errors = [];

  const homepageRes = await fetchText(websiteUrl, { timeoutMs: 20000 });
  pagesTried.push({ requested: websiteUrl, final: homepageRes.url, status: homepageRes.status });

  const homepageHtml = homepageRes.text || "";
  const homepageText = stripTags(homepageHtml);
  const homepageEmails = extractEmailsFromText(homepageHtml);
  if (homepageEmails.length) {
    emailsByPage[homepageRes.url] = homepageEmails;
  }
  pageTextByUrl[homepageRes.url] = homepageText;
  socialByUrl[homepageRes.url] = extractSocialLinksFromHtml(homepageHtml, homepageRes.url || websiteUrl);
  if (homepageRes.ok) pagesOk.push(homepageRes.url);
  else errors.push({ url: websiteUrl, status: homepageRes.status, kind: "homepage_http" });

  const discovered = extractContactPageLinks(homepageHtml, homepageRes.url || websiteUrl);
  const guessed = buildGuessedPaths(homepageRes.url || websiteUrl);
  const pageCandidates = Array.from(new Set([...discovered, ...guessed])).slice(0, 18);

  for (const p of pageCandidates) {
    // Avoid re-fetching homepage.
    if ((homepageRes.url || websiteUrl) === p) continue;
    try {
      const res = await fetchText(p, { timeoutMs: 20000 });
      pagesTried.push({ requested: p, final: res.url, status: res.status });
      if (!res.ok) {
        errors.push({ url: p, status: res.status, kind: "page_http" });
        continue;
      }
      if (!String(res.contentType || "").toLowerCase().includes("text/html")) continue;
      pagesOk.push(res.url);
      const html = res.text || "";
      const text = stripTags(html);
      pageTextByUrl[res.url] = text;
      socialByUrl[res.url] = extractSocialLinksFromHtml(html, res.url);
      const emails = extractEmailsFromText(html);
      if (emails.length) {
        emailsByPage[res.url] = mergeEmails(emailsByPage[res.url] || [], emails);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ url: p, kind: "page_fetch_error", message: msg });
    }
  }

  let emailMentions = [];
  for (const [pageUrl, emails] of Object.entries(emailsByPage)) {
    const pageText = pageTextByUrl[pageUrl] || "";
    for (const email of emails) {
      emailMentions.push({ email, pageUrl, pageText });
    }
  }

  // If at least one on-domain email exists, drop off-domain emails to avoid vendor noise.
  const onDomainMentions = emailMentions.filter((m) => isEmailInSiteDomain(m.email, websiteUrl));
  if (onDomainMentions.length > 0) emailMentions = onDomainMentions;

  const allEmails = mergeEmails([], emailMentions.map((m) => m.email));
  const categorized =
    emailMentions.length > 0
      ? categorizeEmailsWithContext(emailMentions)
      : categorizeEmails({ emails: allEmails, pageText: homepageText });

  const socialMerged = {};
  for (const v of Object.values(socialByUrl)) {
    if (!v || typeof v !== "object") continue;
    for (const [k, list] of Object.entries(v)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      socialMerged[k] = mergeUniqueStrings(socialMerged[k] || [], list);
    }
  }

  return {
    company_slug: slug,
    website_url: websiteUrl,
    emails: categorized,
    contact_pages: Object.keys(emailsByPage),
    social_links_found: socialMerged,
    pages_tried: pagesTried,
    pages_ok: pagesOk,
    errors,
    no_email_found: allEmails.length === 0,
    audited_at: startedAt,
  };
}

async function runPool({ items, concurrency, worker }) {
  const results = [];
  let idx = 0;
  const executing = new Set();

  const enqueue = async () => {
    while (idx < items.length && executing.size < concurrency) {
      const item = items[idx++];
      const p = (async () => worker(item))()
        .then((res) => results.push(res))
        .catch((err) => results.push({ __error: String(err), item }))
        .finally(() => executing.delete(p));
      executing.add(p);
    }
    if (executing.size === 0) return;
    await Promise.race(executing);
    return enqueue();
  };

  await enqueue();
  await Promise.all(executing);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const only = new Set(args.companySlugs);
  console.log(`Out dir: ${args.outDir ? path.resolve(args.outDir) : "(none)"}`);
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);
  console.log(`Concurrency: ${args.concurrency}`);

  const rows = await supabaseListCompanies({ supabaseUrl, supabaseKey });
  const companies = rows
    .map((row) => {
      const slug = String(row?.company_slug || "").trim().toLowerCase();
      const websiteUrl = typeof row?.website_url === "string" ? row.website_url.trim() : "";
      return { slug, websiteUrl, social_links: row?.social_links };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => (args.force ? true : !shouldSkipExistingEmails(c.social_links)));

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  const results = await runPool({
    items: companies,
    concurrency: args.concurrency,
    worker: async (c) => {
      const slug = c.slug;
      try {
        const extracted = await extractForCompany({ slug, websiteUrl: c.websiteUrl });
        writeOut(args.outDir, `${slug}.contacts.json`, extracted);

        const current = c.social_links && typeof c.social_links === "object" && !Array.isArray(c.social_links)
          ? c.social_links
          : {};

        const next = {
          ...current,
          emails: extracted.emails,
          contact_pages: extracted.contact_pages,
          ...(extracted.social_links_found && Object.keys(extracted.social_links_found).length
            ? extracted.social_links_found
            : {}),
          contact_audit: {
            audited_at: extracted.audited_at,
            pages_tried: extracted.pages_tried.length,
            pages_ok: extracted.pages_ok.length,
            errors: extracted.errors?.length ? extracted.errors.slice(0, 6) : [],
            no_email_found: Boolean(extracted.no_email_found),
            pages_ok_sample: extracted.pages_ok.slice(0, 8),
            pages_tried_sample: extracted.pages_tried.slice(0, 8),
          },
        };

        if (args.dryRun) {
          console.log(`[dry-run] ${slug}: emails=${Object.values(extracted.emails).flat().length}`);
          ok += 1;
          return { slug, ok: true };
        }

        await supabasePatchCompany({
          supabaseUrl,
          supabaseKey,
          slug,
          patch: {
            social_links: next,
            emails_general: next.emails?.general || [],
            emails_support: next.emails?.support || [],
            emails_sales: next.emails?.sales || [],
            emails_founder: next.emails?.founder || [],
            emails_other: next.emails?.other || [],
          },
        });

        const count = Object.values(extracted.emails).flat().length;
        console.log(`[ok] ${slug}: emails=${count}`);
        ok += 1;
        return { slug, ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[fail] ${slug}: ${msg}`);

        const nowIso = new Date().toISOString();
        const current = c.social_links && typeof c.social_links === "object" && !Array.isArray(c.social_links)
          ? c.social_links
          : {};

        const next = {
          ...current,
          contact_audit: {
            audited_at: nowIso,
            error: msg,
          },
        };

        writeOut(args.outDir, `${slug}.contacts.json`, {
          company_slug: slug,
          website_url: c.websiteUrl,
          emails: { general: [], support: [], sales: [], founder: [], other: [] },
          contact_pages: [],
          pages_tried: [],
          pages_ok: [],
          errors: [{ kind: "fatal", message: msg }],
          audited_at: nowIso,
        });

        if (!args.dryRun) {
          try {
            await supabasePatchCompany({
              supabaseUrl,
              supabaseKey,
              slug,
              patch: { social_links: next },
            });
          } catch {
            // ignore secondary patch errors
          }
        }

        failed += 1;
        return { slug, ok: false, error: msg };
      }
    },
  });

  // eslint-disable-next-line no-unused-vars
  for (const r of results) {
    // counts are handled in worker (so that progress logs stay simple)
    // This loop exists to make the flow obvious.
  }

  // Determine skipped count (rows with website but already had emails)
  const totalEligible = rows
    .map((row) => {
      const slug = String(row?.company_slug || "").trim().toLowerCase();
      const websiteUrl = typeof row?.website_url === "string" ? row.website_url.trim() : "";
      const social = row?.social_links;
      return { slug, websiteUrl, social };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true)).length;

  skipped = Math.max(0, totalEligible - ok - failed);

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
