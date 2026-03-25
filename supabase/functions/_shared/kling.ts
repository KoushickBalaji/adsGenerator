// Kling API client for Supabase Edge Functions (Deno)
// Official API: https://api.klingai.com
// Auth: Access Key + Secret Key → JWT token → Bearer header

const KLING_BASE_URL = "https://api.klingai.com";

// JWT token cache — reuse until close to expiry
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

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
  };
};

// ─── Elements API ───

/** List available elements from the Kling account */
export async function listElements(
  pageNum = 1,
  pageSize = 50
): Promise<KlingElement[]> {
  const headers = await getHeaders();

  // Try the official API endpoint
  const res = await fetch(
    `${KLING_BASE_URL}/v1/elements?pageNum=${pageNum}&pageSize=${pageSize}`,
    { method: "GET", headers }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kling elements API error ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Handle different response shapes
  const elements =
    data?.data?.elementsList ||
    data?.data?.elements ||
    data?.data ||
    [];

  return Array.isArray(elements) ? elements : [];
}

/** Pick a random element from the account */
export async function getRandomElement(): Promise<KlingElement | null> {
  try {
    const elements = await listElements();
    if (elements.length === 0) return null;
    const idx = Math.floor(Math.random() * elements.length);
    return elements[idx];
  } catch (err) {
    console.error("Failed to fetch elements:", err);
    return null;
  }
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
  image_0?: string; // product image as first frame
  image_1?: string;
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

/** Create a multi-elements video task (with brand ambassador + product) */
export async function createMultiElementsVideo(
  req: CreateMultiElementsVideoRequest
): Promise<KlingResponse> {
  const headers = await getHeaders();

  // Build the request body, only including defined fields
  const body: Record<string, unknown> = {
    model_name: req.model_name ?? "kling-v3-0",
    prompt: req.prompt,
    duration: req.duration ?? "5",
    aspect_ratio: req.aspect_ratio ?? "16:9",
    mode: req.mode ?? "std",
  };

  if (req.image_0) body.image_0 = req.image_0;
  if (req.image_1) body.image_1 = req.image_1;
  if (req.element_1) body.element_1 = req.element_1;
  if (req.element_2) body.element_2 = req.element_2;
  if (req.element_3) body.element_3 = req.element_3;
  if (req.negative_prompt) body.negative_prompt = req.negative_prompt;
  if (req.callback_url) body.callback_url = req.callback_url;

  const res = await fetch(`${KLING_BASE_URL}/v1/videos/multi-elements`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kling multi-elements API error ${res.status}: ${text}`);
  }

  return res.json();
}

/** Query task status (works for both image2video and multi-elements) */
export async function getTaskStatus(taskId: string): Promise<KlingResponse> {
  const headers = await getHeaders();

  // Try multi-elements status first, fall back to image2video
  for (const path of [
    `/v1/videos/multi-elements/${taskId}`,
    `/v1/videos/image2video/${taskId}`,
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
