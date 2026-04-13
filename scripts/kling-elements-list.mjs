#!/usr/bin/env node
/**
 * List Kling custom elements (IDs + names) so you can map them to companies.
 *
 * Requirements:
 * - Node.js 18+ (Node 20+ recommended)
 * - Env vars:
 *   - KLING_ACCESS_KEY
 *   - KLING_SECRET_KEY
 *   - (optional) KLING_BASE_URL (defaults to https://api-singapore.klingai.com)
 *
 * Usage:
 *   node scripts/kling-elements-list.mjs
 *   node scripts/kling-elements-list.mjs --prefix bluestone
 *   node scripts/kling-elements-list.mjs --json
 */

import crypto from "node:crypto";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/kling-elements-list.mjs [options]",
      "",
      "Options:",
      "  --prefix <prefix>   Filter by element name prefix (case-insensitive)",
      "  --json              Output JSON instead of a table",
      "  --page-size <n>     Page size (default: 50)",
      "  --max-pages <n>     Safety cap (default: 20)",
      "  -h, --help          Show help",
      "",
      "Env vars:",
      "  KLING_ACCESS_KEY, KLING_SECRET_KEY, KLING_BASE_URL",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    prefix: "",
    json: false,
    pageSize: 50,
    maxPages: 20,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prefix") {
      args.prefix = String(argv[i + 1] ?? "").trim();
      i++;
      continue;
    }
    if (a === "--json") {
      args.json = true;
      continue;
    }
    if (a === "--page-size") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --page-size");
      args.pageSize = Math.max(1, Math.min(200, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "--max-pages") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --max-pages");
      args.maxPages = Math.max(1, Math.min(200, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "-h" || a === "--help") usage();
    usage(`Unknown argument: ${a}`);
  }

  return args;
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateJwt(accessKey, secretKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const exp = now + 1800;
  const payload = { iss: accessKey, exp, iat: now, nbf: now - 5 };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sig = crypto
    .createHmac("sha256", secretKey)
    .update(signingInput)
    .digest();

  return `${signingInput}.${base64url(sig)}`;
}

function parseJsonPreservingLargeIds(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const patched = trimmed.replace(
    /("(?:element_id|id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g,
    '$1"$2"'
  );
  return JSON.parse(patched);
}

function normalizeElements(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((e) => {
      if (!e || typeof e !== "object") return null;
      const o = e;
      const id =
        typeof o.id === "string"
          ? o.id
          : typeof o.element_id === "string"
            ? o.element_id
            : typeof o.id === "number"
              ? String(o.id)
              : typeof o.element_id === "number"
                ? String(o.element_id)
                : "";
      const name =
        typeof o.name === "string"
          ? o.name
          : typeof o.element_name === "string"
            ? o.element_name
            : "";
      const type = typeof o.type === "string" ? o.type : undefined;
      const description =
        typeof o.description === "string"
          ? o.description
          : typeof o.element_description === "string"
            ? o.element_description
            : undefined;
      if (!id || !name) return null;
      return { id, name, type, description };
    })
    .filter(Boolean);
}

function extractRawElements(data) {
  return (
    data?.data?.list ??
    data?.data?.elements ??
    data?.data?.elementsList ??
    data?.data ??
    data?.list ??
    data?.elements ??
    data?.elementsList ??
    data ??
    []
  );
}

async function listCustomElements({ baseUrl, token, pageNum, pageSize }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/general/custom-elements?pageNum=${encodeURIComponent(
    pageNum
  )}&pageSize=${encodeURIComponent(pageSize)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kling list custom-elements error ${res.status}: ${text}`);
  }
  const json = parseJsonPreservingLargeIds(text);
  const raw = extractRawElements(json);
  return normalizeElements(raw);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    usage("Missing KLING_ACCESS_KEY / KLING_SECRET_KEY in environment.");
  }

  const baseUrl = (process.env.KLING_BASE_URL ?? "https://api-singapore.klingai.com").replace(
    /\/+$/,
    ""
  );
  const token = generateJwt(accessKey, secretKey);

  const all = [];
  for (let pageNum = 1; pageNum <= args.maxPages; pageNum++) {
    const page = await listCustomElements({
      baseUrl,
      token,
      pageNum,
      pageSize: args.pageSize,
    });
    all.push(...page);
    if (page.length < args.pageSize) break;
  }

  const prefix = args.prefix.trim().toLowerCase();
  const filtered = prefix
    ? all.filter((e) => e.name.trim().toLowerCase().startsWith(prefix))
    : all;

  if (args.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log("No custom elements found.");
    return;
  }

  // Simple tabular output: NAME  ID
  console.log("name\tid");
  for (const el of filtered) {
    console.log(`${el.name}\t${el.id}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

