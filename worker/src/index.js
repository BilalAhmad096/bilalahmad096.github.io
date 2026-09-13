import { sendConfirmation, sendContactMessage, sendMeetingRequest, validateContact, validateMeetingRequest } from "./email.js";
import { recordTurn, runWeeklyDigest } from "./insights.js";
import { getAgentConfiguration, runAgent } from "./openai.js";
import { getKnowledgeMetadata } from "./knowledge.js";
import {
  RequestError,
  assertAllowedOrigin,
  corsHeaders,
  enforceRateLimit,
  jsonResponse,
  readJson,
  securityHeaders,
  validateMessages
} from "./security.js";

const encoder = new TextEncoder();

function sseFrame(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function errorResponse(request, env, error) {
  const known = error instanceof RequestError;
  const status = known ? error.status : 500;
  const message = known ? error.publicMessage : "Something went wrong. Please try again shortly.";
  const code = known ? error.code : "internal_error";
  const headers = error?.retryAfter ? { "Retry-After": error.retryAfter } : {};
  if (!known) console.error("Unhandled worker error", error?.name || "unknown_error");
  return jsonResponse(request, env, { ok: false, code, message }, status, headers);
}

async function chatResponse(request, env, ctx) {
  assertAllowedOrigin(request, env);
  await enforceRateLimit(request, env, "chat", Number(env.CHAT_RATE_LIMIT || 20), 60);
  const payload = await readJson(request);
  const messages = validateMessages(payload);
  const requestId = crypto.randomUUID();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const task = (async () => {
    const sendEvent = (event, data) => writer.write(sseFrame(event, data));
    let retrieval = null;
    try {
      await sendEvent("meta", { requestId, assistant: "Ask Mintorian" });
      retrieval = await runAgent({ messages, env, sendEvent });
    } catch (error) {
      const known = error instanceof RequestError;
      console.error("Chat stream failed", requestId, error?.code || error?.name || "unknown_error");
      await sendEvent("error", {
        code: known ? error.code : "assistant_unavailable",
        message: known
          ? error.publicMessage
          : "I’m having trouble connecting right now. You can still explore the About and Publications sections directly."
      });
    } finally {
      await writer.close();
    }
    // Logged only after the response is flushed, so capture can never delay an answer.
    if (retrieval) await recordTurn(env, retrieval);
  })();
  ctx.waitUntil(task);

  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");
  securityHeaders(headers);
  return new Response(stream.readable, { status: 200, headers });
}

async function contactResponse(request, env, ctx) {
  assertAllowedOrigin(request, env);
  await enforceRateLimit(request, env, "contact", Number(env.CONTACT_RATE_LIMIT || 5), 600);
  const payload = await readJson(request, 12000);
  const data = validateContact(payload);
  if (data.spam) return jsonResponse(request, env, { ok: true, accepted: true }, 202);
  const idempotencyKey = request.headers.get("Idempotency-Key") || `contact-${crypto.randomUUID()}`;
  const result = await sendContactMessage(env, data, idempotencyKey.slice(0, 256));
  // Only once the owner has the enquiry, and never allowed to affect this response.
  ctx?.waitUntil?.(sendConfirmation(env, { kind: "contact", recipient: data.email, idempotencyKey }));
  return jsonResponse(request, env, { ok: true, message: "Your message has been sent.", reference: result.deliveryId });
}

async function meetingResponse(request, env, ctx) {
  assertAllowedOrigin(request, env);
  await enforceRateLimit(request, env, "meeting", Number(env.CONTACT_RATE_LIMIT || 5), 600);
  const payload = await readJson(request, 12000);
  const data = validateMeetingRequest(payload);
  if (data.spam) return jsonResponse(request, env, { ok: true, accepted: true, booked: false }, 202);
  const idempotencyKey = request.headers.get("Idempotency-Key") || `meeting-${crypto.randomUUID()}`;
  const result = await sendMeetingRequest(env, data, idempotencyKey.slice(0, 256));
  ctx?.waitUntil?.(sendConfirmation(env, { kind: "meeting", recipient: data.email, idempotencyKey }));
  return jsonResponse(request, env, {
    ok: true,
    booked: false,
    message: "Your meeting request has been sent. This is not a confirmed booking; Bilal will reply by email.",
    reference: result.deliveryId
  });
}

const DIGEST_CRON = "0 8 * * 1";

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
}

// Compares fixed-length digests byte by byte, so the comparison takes the same time
// however much of a guessed token happens to be right.
async function tokensMatch(presented, expected) {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

// Sends one digest on demand, for testing the email without touching the cron. The route
// does not exist unless DIGEST_TRIGGER_TOKEN is set, needs that token as a bearer
// credential, and is rate limited so a leaked token cannot be used to flood the inbox.
async function digestTriggerResponse(request, env) {
  if (!env.DIGEST_TRIGGER_TOKEN) {
    return jsonResponse(request, env, { ok: false, code: "not_found", message: "Not found." }, 404);
  }
  await enforceRateLimit(request, env, "digest-trigger", 3, 3600);
  const presented = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!presented || !(await tokensMatch(presented, env.DIGEST_TRIGGER_TOKEN))) {
    return jsonResponse(request, env, { ok: false, code: "unauthorised", message: "Unauthorised." }, 401);
  }
  const result = await runWeeklyDigest(env);
  return jsonResponse(request, env, { ok: true, ...result });
}

export default {
  async scheduled(event, env, ctx) {
    // Cloudflare kept firing a replaced trigger for well over ten minutes after a deploy
    // reported the new schedule, so confirm which cron actually fired before doing work.
    if (event?.cron && event.cron !== DIGEST_CRON) {
      console.error("Ignoring unexpected cron trigger", event.cron);
      return;
    }
    ctx.waitUntil(runWeeklyDigest(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request, env);
      securityHeaders(headers);
      return new Response(null, { status: 204, headers });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/v1/health")) {
      return jsonResponse(request, env, {
        ok: true,
        service: "Ask Mintorian API",
        knowledge: getKnowledgeMetadata(),
        agent: getAgentConfiguration(env),
        integrations: {
          ai: Boolean(env.OPENAI_API_KEY || env.AI_API_KEY),
          contactDelivery: Boolean(env.RESEND_API_KEY && env.CONTACT_TO_EMAIL && env.CONTACT_FROM_EMAIL),
          liveCalendar: false
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/chat") {
      try {
        return await chatResponse(request, env, ctx);
      } catch (error) {
        return errorResponse(request, env, error);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/contact") {
      try {
        return await contactResponse(request, env, ctx);
      } catch (error) {
        return errorResponse(request, env, error);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/internal/digest") {
      try {
        return await digestTriggerResponse(request, env);
      } catch (error) {
        return errorResponse(request, env, error);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/meeting-request") {
      try {
        return await meetingResponse(request, env, ctx);
      } catch (error) {
        return errorResponse(request, env, error);
      }
    }

    return jsonResponse(request, env, { ok: false, code: "not_found", message: "Not found." }, 404);
  }
};
