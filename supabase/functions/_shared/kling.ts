// Kling API client for Supabase Edge Functions (Deno)
// Auth: Access Key + Secret Key → JWT token → Bearer header
//
// ⚠️ Docs (new system): https://api-singapore.klingai.com
// Some older accounts still work on https://api.klingai.com
const KLING_BASE_URL = (Deno.env.get("KLING_BASE_URL") ??
  "https://api-singapore.klingai.com").replace(/\/+$/, "");

// Non-secret config: for this demo, ONLY use custom elements whose names start with this prefix.
// This prevents accidentally selecting leftover test elements from the Kling account.
export const BRAND_ELEMENT_NAME_PREFIX = "bluestone";

// JWT token cache - reuse until close to expiry
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

// Best-effort anti-repeat for ambassador selection.
// Note: Edge Functions may run on multiple isolates/instances, so this is not a global guarantee.
let lastPickedCustomElementId: string | null = null;

/** Generate a JWT from KLING_ACCESS_KEY + KLING_SECRET_KEY */
async function generateJWT(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && tokenExpiresAt - now > 60) {
    return cachedToken;
  }

  const accessKey = Deno.env.get("KLING_ACCESS_KEY");
  const secretKey = Deno.env.get("KLING_SECRET_KEY");
  if (!accessKey || !secretKey) {
    throw new Error("KLING_ACCESS_KEY and KLING_SECRET_KEY must be set");
  }

  const header = { alg: "HS256", typ: "JWT" };
  const exp = now + 1800;
  const payload = {
    iss: accessKey,
    exp,
    iat: now,
    nbf: now - 5,
  };

  const enc = new TextEncoder();

  function b64url(data: Uint8Array): string {
    const binStr = Array.from(data, (b) => String.fromCharCode(b)).join("");
    return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const headerB64 = b64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  const sigB64 = b64url(new Uint8Array(sig));

  cachedToken = `${signingInput}.${sigB64}`;
  tokenExpiresAt = exp;
  return cachedToken;
}

async function getHeaders(): Promise<Record<string, string>> {
  const token = await generateJWT();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

// ─── Types ───

export type KlingElement = {
  id: string;
  name: string;
  type: "IMAGE" | "VIDEO";
  description?: string;
  cover?: unknown;
  resources?: unknown[];
  official?: boolean;
  createTime?: number;
};

export type KlingTask = {
  task_id: string;
  task_status: "submitted" | "processing" | "succeed" | "failed";
  task_status_msg?: string;
  created_at?: number;
  updated_at?: number;
  task_result?: {
    videos?: Array<{
      id: string;
      url: string;
      duration: string;
    }>;
  };
};

export type KlingResponse = {
  code: number;
  message: string;
  request_id: string;
  data: KlingTask;
};

export type KlingElementsResponse = {
  code: number;
  message: string;
  request_id: string;
  data: {
    elementsList?: KlingElement[];
    elements?: KlingElement[];
    total?: number;
    pageNum?: number;
    pageSize?: number;
    list?: unknown[];
  };
};

// ─── Elements API ───

type KlingGeneralElement = {
  id?: string | number;
  name?: string;
  description?: string;
  element_id?: string | number;
  element_name?: string;
  element_description?: string;
  type?: string;
};

export type CreateCustomElementRequest = {
  element_name: string;
  element_description: string;
  // Can be a publicly accessible URL OR a base64/data-url string depending on account/API.
  element_frontal_image: string;
  element_refer_list: Array<{
    image_url: string;
  }>;
};

export type CreateCustomElementResponse = {
  code: number;
  message: string;
  request_id: string;
  data?: unknown;
};

export type DeleteCustomElementResponse = {
  code: number;
  message: string;
  request_id: string;
  data?: unknown;
};

function parseJsonPreservingLargeIds(text: string): any {
  // Kling element IDs can exceed JS' MAX_SAFE_INTEGER; if parsed as numbers we lose precision
  // and later send the wrong id back to Kling ("Element id not found").
  const trimmed = text.trim();
  // Kling sometimes returns an empty response body for out-of-range pages; treat as no data.
  if (!trimmed) return null;

  const patched = trimmed.replace(
    /("(?:element_id|id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g,
    '$1"$2"'
  );
  return JSON.parse(patched);
}

export function isElementNameEligible(
  name: string,
  prefix = BRAND_ELEMENT_NAME_PREFIX
): boolean {
  const n = name.trim().toLowerCase();
  const p = prefix.trim().toLowerCase();
  return p.length > 0 && n.startsWith(p);
}

function normalizeElements(raw: unknown): KlingElement[] {
  const arr = Array.isArray(raw) ? (raw as KlingGeneralElement[]) : [];
  return arr
    .map((e) => {
      // Prefer element_id/element_name when present (those are the identifiers expected by
      // downstream video APIs). Fall back to id/name for endpoints that only provide those.
      const id = e?.element_id ?? e?.id;
      const name = e?.element_name ?? e?.name;
      if (!id || !name) return null;

      const type =
        e?.type === "VIDEO" || e?.type === "IMAGE"
          ? (e.type as "VIDEO" | "IMAGE")
          : "IMAGE";

      const description =
        e?.description ??
        (e?.element_description ? String(e.element_description) : undefined);

      return {
        id: String(id),
        name: String(name),
        type,
        description,
      } satisfies KlingElement;
    })
    .filter(Boolean) as KlingElement[];
}

async function listElementsFromGeneralEndpoint(
  path: "/v1/general/custom-elements" | "/v1/general/presets-elements",
  pageNum = 1,
  pageSize = 50
): Promise<KlingElement[]> {
  const headers = await getHeaders();
  const url = `${KLING_BASE_URL}${path}?pageNum=${pageNum}&pageSize=${pageSize}`;
  console.log("[listElements] Fetching:", url);

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kling elements API error ${res.status}: ${text}`);
  }

  const text = await res.text();
  const data = parseJsonPreservingLargeIds(text);
  const rawElements =
    data?.data?.list ||
    data?.data?.elements ||
    data?.data?.elementsList ||
    data?.data ||
    data?.list ||
    data?.elements ||
    data?.elementsList ||
    data ||
    [];

  const normalized = normalizeElements(rawElements);
  console.log(`[listElements] Found ${normalized.length} elements`);
  return normalized;
}

/** List available CUSTOM elements from the Kling account (brand-owned subjects). */
export async function listCustomElements(pageNum = 1, pageSize = 50) {
  return listElementsFromGeneralEndpoint(
    "/v1/general/custom-elements",
    pageNum,
    pageSize
  );
}

/** List available PRESET elements from the Kling account (Kling's preset library). */
export async function listPresetElements(pageNum = 1, pageSize = 50) {
  return listElementsFromGeneralEndpoint(
    "/v1/general/presets-elements",
    pageNum,
    pageSize
  );
}

/** Create a CUSTOM element (brand-owned subject) */
export async function createCustomElement(
  req: CreateCustomElementRequest
): Promise<CreateCustomElementResponse> {
  const headers = await getHeaders();
  const url = `${KLING_BASE_URL}/v1/general/custom-elements`;
  console.log("[createCustomElement] Creating:", req.element_name);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kling custom-elements API error ${res.status}: ${text}`);
  }

  const data = parseJsonPreservingLargeIds(text);
  return data as CreateCustomElementResponse;
}

/** Delete a CUSTOM element (brand-owned subject) */
export async function deleteCustomElement(
  elementId: string
): Promise<DeleteCustomElementResponse> {
  const headers = await getHeaders();
  const url = `${KLING_BASE_URL}/v1/general/delete-elements`;
  console.log("[deleteCustomElement] Deleting:", elementId);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ element_id: String(elementId) }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kling delete-elements API error ${res.status}: ${text}`);
  }

  const data = parseJsonPreservingLargeIds(text) ?? {
    code: 0,
    message: "ok",
    request_id: "",
  };
  return data as DeleteCustomElementResponse;
}

/** Pick a random CUSTOM element from the account */
export async function getRandomElement(opts: {
  namePrefix?: string;
} = {}): Promise<KlingElement | null> {
  const elements = await listCustomElements();
  if (elements.length === 0) {
    console.warn("[getRandomElement] No custom elements found in Kling account");
    return null;
  }

  const prefix = opts.namePrefix ?? BRAND_ELEMENT_NAME_PREFIX;
  const eligible = elements.filter((e) => isElementNameEligible(e.name, prefix));
  if (eligible.length === 0) {
    console.warn(
      `[getRandomElement] No eligible custom elements found (expected prefix "${prefix}"). ` +
        `Found ${elements.length} custom element(s) total.`
    );
    return null;
  }

  const pool =
    eligible.length > 1 && lastPickedCustomElementId
      ? eligible.filter((e) => e.id !== lastPickedCustomElementId)
      : eligible;

  const idx = Math.floor(Math.random() * pool.length);
  const picked = pool[idx];
  lastPickedCustomElementId = picked.id;
  console.log(`[getRandomElement] Picked element: ${picked.name} (${picked.id})`);
  return picked;
}

// ─── Video Generation ───

export type CreateImageToVideoRequest = {
  model_name?: string;
  image: string;
  image_tail?: string;
  prompt?: string;
  negative_prompt?: string;
  duration?: string;
  aspect_ratio?: string;
  cfg_scale?: number;
  mode?: string;
  callback_url?: string;
};

export type CreateMultiElementsVideoRequest = {
  model_name?: string;
  prompt: string;
  image_0?: string; // product image angle 1
  image_1?: string; // product image angle 2
  image_2?: string; // product image angle 3
  image_3?: string; // product image angle 4 (max 3 images + elements combined)
  element_1?: string; // element ID (brand ambassador)
  element_2?: string;
  element_3?: string;
  negative_prompt?: string;
  duration?: string;
  aspect_ratio?: string;
  mode?: string;
  callback_url?: string;
};

/** Create an image-to-video task (basic, no elements) */
export async function createImageToVideo(
  req: CreateImageToVideoRequest
): Promise<KlingResponse> {
  const headers = await getHeaders();
  const res = await fetch(`${KLING_BASE_URL}/v1/videos/image2video`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model_name: req.model_name ?? "kling-v1",
      ...req,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kling API error ${res.status}: ${text}`);
  }

  return res.json();
}

export type CreateOmniVideoRequest = {
  model_name: string;
  prompt: string;
  image_list?: Array<{ image_url: string; type?: "first_frame" | "end_frame" }>;
  element_list?: Array<{ element_id: string }>;
  video_list?: Array<{
    video_url: string;
    refer_type?: string;
    keep_original_sound?: string;
  }>;
  mode?: "std" | "pro";
  aspect_ratio?: string;
  duration?: string;
  callback_url?: string;
  external_task_id?: string;
};

/** Create an Omni-Video task (O-series models like kling-video-o1 / kling-video-o3). */
export async function createOmniVideo(
  req: CreateOmniVideoRequest
): Promise<KlingResponse> {
  const headers = await getHeaders();

  const body: Record<string, unknown> = {
    model_name: req.model_name,
    prompt: req.prompt,
    mode: req.mode ?? "pro",
    aspect_ratio: req.aspect_ratio ?? "16:9",
    duration: req.duration ?? "5",
  };

  if (req.image_list) body.image_list = req.image_list;
  if (req.element_list) body.element_list = req.element_list;
  if (req.video_list) body.video_list = req.video_list;
  if (req.callback_url) body.callback_url = req.callback_url;
  if (req.external_task_id) body.external_task_id = req.external_task_id;

  const res = await fetch(`${KLING_BASE_URL}/v1/videos/omni-video`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kling omni-video API error ${res.status}: ${text}`);
  }

  return res.json();
}

/** Query task status (works for both image2video and multi-elements) */
export async function getTaskStatus(taskId: string): Promise<KlingResponse> {
  const headers = await getHeaders();

  // Try Omni-Video first (O-series), then legacy endpoints for older runs.
  for (const path of [
    `/v1/videos/omni-video/${taskId}`,
    `/v1/videos/multi-elements/${taskId}`,
    `/v1/videos/image2video/${taskId}`,
    `/v1/videos/text2video/${taskId}`,
  ]) {
    const res = await fetch(`${KLING_BASE_URL}${path}`, {
      method: "GET",
      headers,
    });

    if (res.ok) {
      return res.json();
    }
  }

  throw new Error(`Could not find task ${taskId}`);
}
