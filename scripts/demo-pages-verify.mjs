#!/usr/bin/env node
/**
 * Verify that demo pages are reachable and (optionally) store the status in company_prompt_profiles.
 *
 * Writes (if columns exist):
 * - demo_http_status
 * - demo_verified_at
 * - (optionally) demo_url (if missing)
 *
 * Usage:
 *   node scripts/demo-pages-verify.mjs --company quirksmith --company klarity
 *   node scripts/demo-pages-verify.mjs --wave 1
 *   node scripts/demo-pages-verify.mjs --dry-run
 *
 * Env vars (or .env.local):
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - (optional) DEMO_BASE_URL (default: https://ads-generator-hazel.vercel.app)
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/demo-pages-verify.mjs [options]",
      "",
      "Options:",
      "  --company <slug>   Only verify this company (repeatable)",
      "  --wave <n>         Verify companies with outreach_wave=<n>",
      "  --timeout-ms <n>   HTTP timeout (default: 15000)",
      "  --dry-run          Do not write to Supabase",
      "  -h, --help         Show help",
      "",
      "Env vars (or .env.local):",
      "  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEMO_BASE_URL",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    companySlugs: [],
    wave: null,
    timeoutMs: 15000,
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
    if (a === "--wave") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --wave");
      args.wave = Math.trunc(n);
      i++;
      continue;
    }
    if (a === "--timeout-ms") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --timeout-ms");
      args.timeoutMs = Math.trunc(n);
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
    if (k) out[k] = v;
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,*/*;q=0.8",
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function supabaseListCompanies({ restBase, headers, only, wave }) {
  const select = "company_slug";
  const params = new URLSearchParams();
  params.set("select", select);
  params.set("order", "company_slug.asc");
  if (only && only.size > 0) {
    const list = `(${Array.from(only).map((s) => `"${s}"`).join(",")})`;
    params.set("company_slug", `in.${list}`);
  } else if (typeof wave === "number") {
    params.set("outreach_wave", `eq.${wave}`);
  }
  const url = `${restBase}/company_prompt_profiles?${params.toString()}`;
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET error ${res.status}: ${text}`);
  const json = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(json)) throw new Error("Supabase GET did not return an array");
  return json;
}

async function supabasePreflight({ restBase, headers }) {
  const url = `${restBase}/company_prompt_profiles?select=company_slug,demo_url,demo_http_status,demo_verified_at&limit=1`;
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  if (res.ok) return true;
  if (res.status === 400 && /does not exist/i.test(text)) return false;
  throw new Error(`Supabase preflight error ${res.status}: ${text}`);
}

async function supabaseHasOutreachWaveColumn({ restBase, headers }) {
  const url = `${restBase}/company_prompt_profiles?select=company_slug,outreach_wave&limit=1`;
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  if (res.ok) return true;
  if (res.status === 400 && /does not exist/i.test(text)) return false;
  throw new Error(`Supabase preflight error ${res.status}: ${text}`);
}

async function supabaseGetDemoUrlIfExists({ restBase, headers, slug }) {
  const url =
    `${restBase}/company_prompt_profiles?select=company_slug,demo_url` +
    `&company_slug=eq.${encodeURIComponent(slug)}`;
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 400 && /does not exist/i.test(text)) return null;
    throw new Error(`Supabase GET error ${res.status}: ${text}`);
  }
  const json = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(json) || json.length === 0) return null;
  const val = json[0]?.demo_url;
  return typeof val === "string" && val.trim() ? val.trim() : "";
}

async function supabasePatchCompany({ restBase, headers, slug, patch }) {
  const url = `${restBase}/company_prompt_profiles?company_slug=eq.${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH error ${res.status}: ${text}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");
  const demoBaseUrl = String(process.env.DEMO_BASE_URL || dotEnv.DEMO_BASE_URL || "https://ads-generator-hazel.vercel.app")
    .trim()
    .replace(/\/+$/, "");

  const restBase = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  const only = new Set(args.companySlugs.map(normalizeSlug).filter(Boolean));
  if (only.size === 0 && args.wave == null) {
    usage("Provide --company <slug> (repeatable) or --wave <n>.");
  }

  const hasDemoColumns = await supabasePreflight({ restBase, headers });
  const hasWaveColumn = await supabaseHasOutreachWaveColumn({ restBase, headers });
  if (args.wave != null && !hasWaveColumn) {
    throw new Error(
      "outreach_wave column is missing in the remote DB. Run `supabase db push` to apply migrations, or pass explicit --company <slug> arguments instead."
    );
  }
  const canWriteColumns = !args.dryRun && hasDemoColumns;

  if (!hasDemoColumns) {
    console.warn(
      "Demo columns are missing in the remote DB. Run `supabase db push` to apply migrations, then rerun this script."
    );
  }

  const rows = await supabaseListCompanies({
    restBase,
    headers,
    only: only.size > 0 ? only : null,
    wave: args.wave,
  });

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    const slug = normalizeSlug(row?.company_slug);
    if (!slug) continue;

    const demoUrlFromDb = hasDemoColumns
      ? (await supabaseGetDemoUrlIfExists({ restBase, headers, slug })) || ""
      : "";
    const demoUrl = demoUrlFromDb || `${demoBaseUrl}/demo/${slug}`;

    try {
      const res = await fetchText(demoUrl, args.timeoutMs);
      const looksLikeDemo = /Video Demo/i.test(res.text) && /Company:/i.test(res.text);

      const status = res.status;
      const tag = looksLikeDemo ? "ok" : "warn";
      console.log(`[${tag}] ${slug}: ${status} ${demoUrl}`);

      if (canWriteColumns && looksLikeDemo) {
        await supabasePatchCompany({
          restBase,
          headers,
          slug,
          patch: {
            ...(demoUrlFromDb ? {} : { demo_url: demoUrl }),
            demo_http_status: status,
            demo_verified_at: new Date().toISOString(),
          },
        });
      }

      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fail] ${slug}: ${msg}`);
      failed += 1;

      if (canWriteColumns) {
        try {
          await supabasePatchCompany({
            restBase,
            headers,
            slug,
            patch: {
              ...(demoUrlFromDb ? {} : { demo_url: demoUrl }),
              demo_http_status: null,
              demo_verified_at: new Date().toISOString(),
            },
          });
        } catch {
          // ignore
        }
      }
    }
  }

  console.log(`\nDone. ok=${ok} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
