#!/usr/bin/env node
/**
 * Bulk-create Kling custom elements (brand ambassadors) from local files or URLs.
 *
 * Requirements:
 * - Node.js 18+ (Node 20+ recommended)
 * - Env vars:
 *   - KLING_ACCESS_KEY
 *   - KLING_SECRET_KEY
 *   - (optional) KLING_BASE_URL (defaults to https://api-singapore.klingai.com)
 *
 * Usage:
 *   node scripts/kling-elements-upload.mjs --manifest "D:\\path\\elements.manifest.json"
 *   node scripts/kling-elements-upload.mjs --manifest "D:\\path\\elements.manifest.json" --data-url
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      '  node scripts/kling-elements-upload.mjs --manifest "<path>" [--data-url] [--dry-run]',
      "",
      "Manifest format:",
      "  {",
      '    "prefix": "bluestone",',
      '    "elements": [',
      "      {",
      '        "name": "bluestone-anya",',
      '        "description": "Optional description",',
      '        "frontal": "D:/assets/anya/front.jpg",',
      '        "refs": ["D:/assets/anya/ref1.jpg", "D:/assets/anya/ref2.jpg"]',
      "      }",
      "    ]",
      "  }",
      "",
      "Notes:",
      "- For local images, the script sends Base64 by default.",
      "- If Kling expects data-URLs instead, rerun with --data-url.",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { manifest: null, dataUrl: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest") {
      args.manifest = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--data-url") {
      args.dataUrl = true;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "-h" || a === "--help") usage();
    // Allow passing manifest as first positional arg.
    if (!args.manifest && !a.startsWith("-")) {
      args.manifest = a;
      continue;
    }
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

function isEligibleName(name, prefix) {
  return (
    typeof name === "string" &&
    typeof prefix === "string" &&
    prefix.trim().length > 0 &&
    name.trim().toLowerCase().startsWith(prefix.trim().toLowerCase())
  );
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function loadImageAsString(input, { dataUrl }) {
  if (!input || typeof input !== "string") {
    throw new Error(`Invalid image input: ${String(input)}`);
  }

  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const buf = fs.readFileSync(resolved);
  const b64 = buf.toString("base64");
  if (!dataUrl) return b64;
  const mime = guessMimeType(resolved);
  return `data:${mime};base64,${b64}`;
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

async function createCustomElement({
  baseUrl,
  token,
  name,
  description,
  frontal,
  refs,
  dataUrl,
  dryRun,
}) {
  if (!name) throw new Error("Element name is required");
  if (!frontal) throw new Error(`Element "${name}": frontal image is required`);
  if (!Array.isArray(refs) || refs.length < 1) {
    throw new Error(`Element "${name}": provide at least 1 reference image`);
  }
  if (refs.length > 3) {
    throw new Error(`Element "${name}": max 3 reference images are supported`);
  }

  const element_frontal_image = loadImageAsString(frontal, { dataUrl });
  const element_refer_list = refs.map((r) => ({
    image_url: loadImageAsString(r, { dataUrl }),
  }));

  const body = {
    element_name: name,
    element_description: description ?? name,
    element_frontal_image,
    element_refer_list,
  };

  if (dryRun) return { ok: true, skipped: true, bodyPreview: body };

  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/general/custom-elements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kling create custom element error ${res.status}: ${text}`);
  }

  const json = parseJsonPreservingLargeIds(text);
  return { ok: true, response: json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) usage("Missing --manifest");

  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    usage("Missing KLING_ACCESS_KEY / KLING_SECRET_KEY in environment.");
  }

  const baseUrl =
    (process.env.KLING_BASE_URL ?? "https://api-singapore.klingai.com").replace(/\/+$/, "");
  const token = generateJwt(accessKey, secretKey);

  const manifestPath = path.resolve(args.manifest);
  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);

  const prefix = (manifest?.prefix ?? "bluestone").trim();
  const elements = Array.isArray(manifest?.elements) ? manifest.elements : [];
  if (elements.length === 0) usage("Manifest has no elements to create.");

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Eligible prefix: "${prefix}"`);
  console.log(`Elements to create: ${elements.length}`);

  const results = [];
  for (const el of elements) {
    const name = String(el?.name ?? "").trim();
    if (!isEligibleName(name, prefix)) {
      throw new Error(
        `Element name "${name}" is not eligible. Expected name to start with "${prefix}".`
      );
    }

    console.log(`\nCreating: ${name}`);
    const out = await createCustomElement({
      baseUrl,
      token,
      name,
      description: el?.description ? String(el.description) : undefined,
      frontal: el?.frontal ? String(el.frontal) : "",
      refs: Array.isArray(el?.refs) ? el.refs.map(String) : [],
      dataUrl: args.dataUrl,
      dryRun: args.dryRun,
    });

    results.push({ name, ...out });
    console.log(args.dryRun ? "Dry run OK" : "Created OK");
  }

  console.log("\nDone. Summary:");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

