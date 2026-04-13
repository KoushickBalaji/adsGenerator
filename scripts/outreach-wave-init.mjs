#!/usr/bin/env node
/**
 * Initialize outreach wave + status fields on `public.company_prompt_profiles`.
 *
 * Intended usage:
 * - After running `supabase db push` (so the columns exist)
 * - Set `outreach_wave` for the first few companies you want to contact
 * - Optionally reset their `outreach_status` to "todo"
 *
 * Usage:
 *   node scripts/outreach-wave-init.mjs
 *   node scripts/outreach-wave-init.mjs --dry-run
 *   node scripts/outreach-wave-init.mjs --force-status
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/outreach-wave-init.mjs [options]",
      "",
      "Options:",
      "  --dry-run         Do not write to Supabase",
      "  --force-status    Overwrite outreach_status to 'todo' for the selected companies",
      "  -h, --help        Show help",
      "",
      "Env vars (or .env.local):",
      "  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { dryRun: false, forceStatus: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "--force-status") {
      args.forceStatus = true;
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

async function supabasePreflight({ supabaseUrl, supabaseKey }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?select=company_slug,outreach_wave,outreach_status&limit=1`;
  const res = await fetch(url, {
    method: "GET",
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const text = await res.text();
  if (res.ok) return;
  if (res.status === 400 && /does not exist/i.test(text)) {
    throw new Error(
      "Outreach columns are missing in the remote DB. Run `supabase db push` to apply the latest migrations, then rerun this script."
    );
  }
  throw new Error(`Supabase preflight error ${res.status}: ${text}`);
}

function buildWaveAssignments() {
  // Wave 1: smaller / Bengaluru-first / faster iteration loop.
  const wave1 = [
    "quirksmith",
    "klarity",
    "iyal-silvers",
    "caratcult",
    "onya",
    "aukera",
    "kushals",
    "shravia",
    "houseofmila",
    "ishhaara",
  ];

  // Wave 2: larger brands or more process-heavy (reach out after pitch is polished).
  const wave2 = ["giva", "melorra", "bluestone"];

  return { wave1, wave2 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  if (!args.dryRun) {
    await supabasePreflight({ supabaseUrl, supabaseKey });
  }

  const { wave1, wave2 } = buildWaveAssignments();
  const all = [
    ...wave1.map((s) => ({ slug: s, wave: 1 })),
    ...wave2.map((s) => ({ slug: s, wave: 2 })),
  ].map((r) => ({ slug: normalizeSlug(r.slug), wave: r.wave }));

  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);

  let ok = 0;
  let failed = 0;

  for (const row of all) {
    if (!row.slug) continue;
    const patch = {
      outreach_wave: row.wave,
      ...(args.forceStatus ? { outreach_status: "todo" } : {}),
    };
    if (args.dryRun) {
      console.log(`[dry-run] ${row.slug}: outreach_wave=${row.wave}${args.forceStatus ? " outreach_status=todo" : ""}`);
      ok += 1;
      continue;
    }
    try {
      await supabasePatchCompany({ supabaseUrl, supabaseKey, slug: row.slug, patch });
      console.log(`[ok] ${row.slug}: outreach_wave=${row.wave}`);
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fail] ${row.slug}: ${msg}`);
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
