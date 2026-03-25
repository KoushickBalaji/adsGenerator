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

  // JWT Header
  const header = { alg: "HS256", typ: "JWT" };

  // JWT Payload — Kling expects iss (access key), exp, iat, nbf
  const exp = now + 1800; // 30 minute expiry
  const payload = {
    iss: accessKey,
    exp,
    iat: now,
    nbf: now - 5, // small clock skew tolerance
  };

  const enc = new TextEncoder();

  // Base64url encode helper
  function b64url(data: Uint8Array): string {
    const binStr = Array.from(data, (b) => String.fromCharCode(b)).join("");
    return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const headerB64 = b64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // HMAC-SHA256 sign
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

export type ImageListItem = {
  image: string; // publicly accessible image URL
  image_type: "first_frame" | "end_frame";
};

export type MultiPromptItem = {
  index: number; // 0-5
  prompt: string;
  duration: number; // seconds, min 3
};

export type CreateVideoRequest = {
  model_name?: string;
  image: string; // primary image URL (required for image-to-video)
  image_tail?: string; // optional end frame image URL
  prompt?: string;
  negative_prompt?: string;
  image_list?: ImageListItem[]; // alternative format (if supported)
  multi_shot?: boolean;
  multi_prompt?: MultiPromptItem[];
  duration?: string; // "5" or "10" (string, not number)
  aspect_ratio?: string; // "16:9" | "9:16" | "1:1"
  cfg_scale?: number; // 0-1
  mode?: string; // "std" or "pro"
  callback_url?: string;
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

/** Create an image-to-video task */
export async function createImageToVideo(
  req: CreateVideoRequest
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

/** Query task status */
export async function getTaskStatus(taskId: string): Promise<KlingResponse> {
  const headers = await getHeaders();
  const res = await fetch(
    `${KLING_BASE_URL}/v1/videos/image2video/${taskId}`,
    {
      method: "GET",
      headers,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kling API error ${res.status}: ${text}`);
  }

  return res.json();
}
