#!/usr/bin/env node
/**
 * Seed (upsert) minimal `company_prompt_profiles` rows from a JSON file.
 *
 * This is for building an outreach funnel: it stores each company's `website_url`
 * so the demo can later be configured + audited.
 *
 * Requirements:
 * - Node.js 18+ (Node 20+ recommended)
 * - Env vars (or .env.local):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node scripts/company-prompt-profiles-seed.mjs --companies scripts/companies.india.json
 *   node scripts/company-prompt-profiles-seed.mjs --companies scripts/companies.india.json --company giva --company bluestone
 *   node scripts/company-prompt-profiles-seed.mjs --companies scripts/companies.india.json --force
 *   node scripts/company-prompt-profiles-seed.mjs --companies scripts/companies.india.json --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-prompt-profiles-seed.mjs --companies <path> [options]",
      "",
      "Options:",
      "  --companies <path>   JSON file: [{ slug, website, ... }, ...]",
      "  --company <slug>     Only seed this company slug (repeatable)",
      "  --force              Overwrite existing row (default: skip existing)",
      "  --dry-run            Do not write to Supabase",
      "  -h, --help           Show help",
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
    companiesPath: null,
    companySlugs: [],
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--companies") {
      args.companiesPath = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim();
      if (slug) args.companySlugs.push(slug.toLowerCase());
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

function readJsonFile(filePath) {
  const raw = fs.readFileSync(path.resolve(filePath), "utf8");
  const json = JSON.parse(raw);
  if (!Array.isArray(json)) throw new Error("Companies JSON must be an array.");
  return json;
}

function normalizeSlug(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function normalizeWebsite(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return `https://${s.replace(/^\/+/, "")}`;
  return s;
}

async function supabaseGetExisting({ supabaseUrl, supabaseKey, slug }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?select=company_slug&company_slug=eq.${encodeURIComponent(slug)}&limit=1`;

  const res = await fetch(url, {
    method: "GET",
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET error ${res.status}: ${text}`);
  const json = text.trim() ? JSON.parse(text) : [];
  return Array.isArray(json) && json.length > 0 ? json[0] : null;
}

async function supabaseUpsert({ supabaseUrl, supabaseKey, row }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?on_conflict=company_slug`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status}: ${text}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.companiesPath) usage("Missing --companies <path>");

  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const only = new Set(args.companySlugs.map((s) => normalizeSlug(s)).filter(Boolean));
  const companies = readJsonFile(args.companiesPath);

  const seen = new Set();
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`Companies file: ${path.resolve(args.companiesPath)}`);
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);

  for (const item of companies) {
    try {
      const slug = normalizeSlug(item?.slug ?? "");
      if (!slug) continue;
      if (only.size > 0 && !only.has(slug)) continue;
      if (seen.has(slug)) continue;
      seen.add(slug);

      const website = normalizeWebsite(item?.website ?? "");
      if (!website) {
        console.warn(`[skip] ${slug}: missing website`);
        skipped += 1;
        continue;
      }

      const exists = await supabaseGetExisting({ supabaseUrl, supabaseKey, slug });
      if (exists && !args.force) {
        console.log(`[skip] ${slug}: row exists (use --force to overwrite)`);
        skipped += 1;
        continue;
      }

      const row = {
        company_slug: slug,
        website_url: website,
      };

      if (args.dryRun) {
        console.log(`[dry-run] would upsert: ${slug} -> ${website}`);
        ok += 1;
        continue;
      }

      await supabaseUpsert({ supabaseUrl, supabaseKey, row });
      console.log(`[ok] ${slug}`);
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fail] ${String(item?.slug ?? "unknown")}: ${msg}`);
      failed += 1;
    }
  }

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

