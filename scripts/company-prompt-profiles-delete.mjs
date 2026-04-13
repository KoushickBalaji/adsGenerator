#!/usr/bin/env node
/**
 * Delete `company_prompt_profiles` rows by slug (service-role only).
 *
 * Usage:
 *   node scripts/company-prompt-profiles-delete.mjs --company <slug> [--company <slug> ...]
 *   node scripts/company-prompt-profiles-delete.mjs --companies <path>
 *
 * Options:
 *   --company <slug>     Delete this slug (repeatable)
 *   --companies <path>   JSON file: [{ slug, ... }, ...] (deletes all slugs in the file)
 *   --dry-run            Print what would be deleted
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-prompt-profiles-delete.mjs [options]",
      "",
      "Options:",
      "  --company <slug>     Delete this slug (repeatable)",
      "  --companies <path>   JSON file: [{ slug, ... }, ...]",
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
      if (slug) args.companySlugs.push(slug);
      i++;
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

function normalizeSlug(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function readCompaniesSlugs(filePath) {
  const raw = fs.readFileSync(path.resolve(filePath), "utf8");
  const json = JSON.parse(raw);
  if (!Array.isArray(json)) throw new Error("Companies JSON must be an array.");
  return json.map((c) => c?.slug).filter(Boolean);
}

async function supabaseDeleteCompany({ supabaseUrl, supabaseKey, slug }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?company_slug=eq.${encodeURIComponent(slug)}`;

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: "return=minimal",
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase DELETE error ${res.status}: ${text}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const slugs = new Set(
    [
      ...args.companySlugs,
      ...(args.companiesPath ? readCompaniesSlugs(args.companiesPath) : []),
    ]
      .map(normalizeSlug)
      .filter(Boolean)
  );

  if (slugs.size === 0) usage("Nothing to delete (provide --company or --companies).");

  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);

  let ok = 0;
  let failed = 0;
  for (const slug of Array.from(slugs).sort()) {
    try {
      if (args.dryRun) {
        console.log(`[dry-run] would delete: ${slug}`);
        ok += 1;
        continue;
      }
      await supabaseDeleteCompany({ supabaseUrl, supabaseKey, slug });
      console.log(`[ok] deleted: ${slug}`);
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fail] ${slug}: ${msg}`);
      failed += 1;
    }
  }

  console.log(`\nDone. ok=${ok} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

