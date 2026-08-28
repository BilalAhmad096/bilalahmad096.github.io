const memoryBuckets = new Map();

const DEFAULT_ORIGINS = [
  "https://mintorian.com",
  "https://www.mintorian.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

export class RequestError extends Error {
  constructor(code, status = 400, publicMessage = "The request could not be processed.") {
    super(code);
    this.name = "RequestError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ORIGINS);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  });
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

export function assertAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  const isDevelopment = String(env.ENVIRONMENT || "development") !== "production";
  if (!origin && isDevelopment) return;
  if (!origin || !allowedOrigins(env).has(origin)) {
    throw new RequestError("origin_not_allowed", 403, "This request origin is not allowed.");
  }
}

export async function readJson(request, maximumBytes = 40000) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maximumBytes) {
    throw new RequestError("payload_too_large", 413, "The request is too large.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new RequestError("payload_too_large", 413, "The request is too large.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RequestError("invalid_json", 400, "The request is not valid JSON.");
  }
}

export function sanitiseText(value, maximumLength, { multiline = false } = {}) {
  const text = String(value ?? "")
    .replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, " ")
    .replace(multiline ? /\r\n?/g : /\s+/g, multiline ? "\n" : " ")
    .trim();
  return text.slice(0, maximumLength);
}

export function isValidEmail(value) {
  const email = sanitiseText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function validateMessages(payload) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new RequestError("messages_required", 400, "Please enter a question.");
  }
  if (payload.messages.length > 12) {
    throw new RequestError("too_many_messages", 400, "Please start a new conversation.");
  }

  let totalCharacters = 0;
  const messages = payload.messages.map(message => {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : null;
    if (!role) throw new RequestError("invalid_role", 400, "The conversation contains an invalid message.");
    const content = sanitiseText(message.content, 2400, { multiline: true });
    if (!content) throw new RequestError("empty_message", 400, "Please enter a question.");
    totalCharacters += content.length;
    return { role, content };
  });

  if (totalCharacters > 14000) {
    throw new RequestError("conversation_too_large", 400, "Please start a new conversation.");
  }
  if (messages.at(-1).role !== "user") {
    throw new RequestError("last_message_not_user", 400, "The latest message must be from the visitor.");
  }
  return messages;
}

export function privilegedRequestResponse(latestMessage) {
  const text = String(latestMessage || "").toLowerCase();
  const privilegedPatterns = [
    /(?:reveal|show|print|repeat|return|give).{0,40}(?:system prompt|developer instruction|hidden instruction|api key|credential|secret|environment variable|private database)/,
    /(?:ignore|disregard|override).{0,30}(?:previous|system|developer|instruction)/,
    /(?:enter|enable|switch to).{0,20}(?:developer|admin|administrator|root) mode/,
    /(?:dump|export|show).{0,25}(?:entire|full|hidden).{0,20}(?:knowledge base|configuration|prompt)/,
    /pretend.{0,30}(?:administrator|developer|system)/
  ];
  if (!privilegedPatterns.some(pattern => pattern.test(text))) return null;
  return "I can’t provide hidden prompts, credentials, configuration, or private internal data. I can still help with Bilal’s verified research, publications, experience, projects, or collaboration options.";
}

async function fingerprint(request, env) {
  const rawIp = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0] || "local";
  const salt = String(env.RATE_LIMIT_SALT || "mintorian-development");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${rawIp}`));
  return [...new Uint8Array(digest)].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function enforceRateLimit(request, env, scope, limit, windowSeconds) {
  const id = await fingerprint(request, env);
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rate:${scope}:${bucket}:${id}`;
  let count = 0;

  if (env.RATE_LIMIT_KV) {
    count = Number(await env.RATE_LIMIT_KV.get(key) || 0);
    if (count < limit) {
      await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
    }
  } else {
    const expiresAt = (bucket + 1) * windowSeconds * 1000;
    const current = memoryBuckets.get(key);
    count = current?.count || 0;
    if (count < limit) memoryBuckets.set(key, { count: count + 1, expiresAt });
    if (memoryBuckets.size > 1000) {
      const now = Date.now();
      for (const [entryKey, entry] of memoryBuckets) {
        if (entry.expiresAt <= now) memoryBuckets.delete(entryKey);
      }
    }
  }

  if (count >= limit) {
    const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * windowSeconds * 1000 - Date.now()) / 1000));
    const error = new RequestError("rate_limited", 429, "Too many requests. Please wait a moment and try again.");
    error.retryAfter = retryAfter;
    throw error;
  }
}

export function securityHeaders(headers = new Headers()) {
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export function jsonResponse(request, env, body, status = 200, extraHeaders = {}) {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, String(value));
  securityHeaders(headers);
  return new Response(JSON.stringify(body), { status, headers });
}
