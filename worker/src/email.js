import { RequestError, isValidEmail, sanitiseText } from "./security.js";

const CONTACT_REASONS = new Set([
  "Research collaboration",
  "Professional opportunity",
  "Speaking invitation",
  "Publication discussion",
  "Other"
]);

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function validateIdentity(payload) {
  const name = sanitiseText(payload?.name, 100);
  const email = sanitiseText(payload?.email, 254).toLowerCase();
  if (name.length < 2) throw new RequestError("invalid_name", 400, "Please provide your name.");
  if (!isValidEmail(email)) throw new RequestError("invalid_email", 400, "Please provide a valid email address.");
  return { name, email };
}

function isHoneypotFilled(payload) {
  return Boolean(sanitiseText(payload?.company, 120));
}

export function validateContact(payload) {
  if (isHoneypotFilled(payload)) return { spam: true };
  const identity = validateIdentity(payload);
  const requestedReason = sanitiseText(payload?.reason, 80);
  const reason = CONTACT_REASONS.has(requestedReason) ? requestedReason : "Other";
  const message = sanitiseText(payload?.message, 3000, { multiline: true });
  if (message.length < 10) throw new RequestError("invalid_message", 400, "Please provide a little more detail in your message.");
  return { ...identity, reason, message, spam: false };
}

export function validateMeetingRequest(payload) {
  if (isHoneypotFilled(payload)) return { spam: true };
  const identity = validateIdentity(payload);
  const topic = sanitiseText(payload?.topic, 500, { multiline: true });
  const preferredWindow = sanitiseText(payload?.preferredWindow, 300, { multiline: true });
  const timezone = sanitiseText(payload?.timezone, 100);
  if (topic.length < 5) throw new RequestError("invalid_topic", 400, "Please describe what you would like to discuss.");
  if (preferredWindow.length < 3) throw new RequestError("invalid_time", 400, "Please suggest a preferred date or time window.");
  return { ...identity, topic, preferredWindow, timezone: timezone || "Not provided", spam: false };
}

async function sendViaResend(env, message, idempotencyKey) {
  if (!env.RESEND_API_KEY || !env.CONTACT_TO_EMAIL || !env.CONTACT_FROM_EMAIL) {
    throw new RequestError(
      "contact_not_configured",
      503,
      "Online sending is not configured yet. Please email connect@mintorian.com instead."
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      from: env.CONTACT_FROM_EMAIL,
      to: [env.CONTACT_TO_EMAIL],
      reply_to: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html
    })
  });

  if (!response.ok) {
    console.error("Resend request failed", response.status);
    throw new RequestError(
      "message_delivery_failed",
      502,
      "Your message couldn’t be sent. Please try again or email connect@mintorian.com."
    );
  }

  const result = await response.json();
  return { deliveryId: result.id };
}

export async function sendContactMessage(env, data, idempotencyKey) {
  const subject = `[Mintorian enquiry] ${data.reason} — ${data.name}`;
  const text = [
    "New Mintorian website enquiry",
    "",
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Reason: ${data.reason}`,
    "",
    data.message
  ].join("\n");
  const html = `<h2>New Mintorian website enquiry</h2>
    <p><strong>Name:</strong> ${escapeHtml(data.name)}<br>
    <strong>Email:</strong> ${escapeHtml(data.email)}<br>
    <strong>Reason:</strong> ${escapeHtml(data.reason)}</p>
    <p>${escapeHtml(data.message).replaceAll("\n", "<br>")}</p>`;
  return sendViaResend(env, { subject, text, html, replyTo: data.email }, idempotencyKey);
}

export async function sendMeetingRequest(env, data, idempotencyKey) {
  const subject = `[Mintorian meeting request] ${data.name}`;
  const text = [
    "New meeting request from the Mintorian website",
    "This is a request only; no meeting has been booked.",
    "",
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Timezone: ${data.timezone}`,
    `Preferred date/time: ${data.preferredWindow}`,
    "",
    `Topic: ${data.topic}`
  ].join("\n");
  const html = `<h2>New Mintorian meeting request</h2>
    <p><strong>This is a request only; no meeting has been booked.</strong></p>
    <p><strong>Name:</strong> ${escapeHtml(data.name)}<br>
    <strong>Email:</strong> ${escapeHtml(data.email)}<br>
    <strong>Timezone:</strong> ${escapeHtml(data.timezone)}<br>
    <strong>Preferred date/time:</strong> ${escapeHtml(data.preferredWindow)}</p>
    <p><strong>Topic:</strong><br>${escapeHtml(data.topic).replaceAll("\n", "<br>")}</p>`;
  return sendViaResend(env, { subject, text, html, replyTo: data.email }, idempotencyKey);
}

// Operational mail sent by the scheduled digest rather than by a visitor. It reports
// failures to the logs instead of raising visitor-facing errors, and it never throws:
// a broken digest must not take the cron run down with it.
export async function sendOperationalEmail(env, { subject, text, html }) {
  const recipient = env.DIGEST_TO_EMAIL || env.CONTACT_TO_EMAIL;
  if (!env.RESEND_API_KEY || !recipient || !env.CONTACT_FROM_EMAIL) {
    console.error("Digest email is not configured");
    return false;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.CONTACT_FROM_EMAIL,
        to: [recipient],
        subject,
        text,
        html
      })
    });
    if (!response.ok) {
      console.error("Digest email failed", response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Digest email error", error?.name || "unknown_error");
    return false;
  }
}
