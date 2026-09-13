import { RequestError, isValidEmail, sanitiseText } from "./security.js";
import { COLOUR, button, cardRow, detailRows, emailDocument, escapeHtml, multilineHtml, notice, textPanel } from "./email-layout.js";

const CONTACT_REASONS = new Set([
  "Research collaboration",
  "Professional opportunity",
  "Speaking invitation",
  "Publication discussion",
  "Other"
]);

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

// Visitor mail is read in the owner's inbox, so times are shown in UK time.
function receivedAt(now) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(now));
}

function firstName(name) {
  return String(name).trim().split(/\s+/)[0] || "them";
}

function emailLink(address) {
  return `<a href="mailto:${escapeHtml(address)}" style="color:${COLOUR.accent};text-decoration:none;">${escapeHtml(address)}</a>`;
}

function snippet(value, limit = 90) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function visitorFooter(formName, name) {
  return `Sent from the ${formName} on <a href="https://mintorian.com" style="color:${COLOUR.accent};text-decoration:none;">mintorian.com</a>.<br>
        Replying to this email goes straight to ${escapeHtml(firstName(name))}.`;
}

export function renderContactEmail(data, now = Date.now()) {
  const subject = `[Mintorian enquiry] ${data.reason}, ${data.name}`;
  const text = [
    "New Mintorian website enquiry",
    `Received ${receivedAt(now)}`,
    "",
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Reason: ${data.reason}`,
    "",
    data.message
  ].join("\n");

  const html = emailDocument({
    preheader: `${data.name}, ${data.reason}: ${snippet(data.message)}`,
    titleHtml: "New enquiry",
    subline: `From ${data.name}, ${receivedAt(now)}`,
    bodyHtml: [
      cardRow(detailRows([
        ["Name", escapeHtml(data.name)],
        ["Email", emailLink(data.email)],
        ["Reason", escapeHtml(data.reason)]
      ]), 24),
      cardRow(textPanel("Message", multilineHtml(data.message)), 24),
      cardRow(button(`Reply to ${firstName(data.name)}`, `mailto:${data.email}?subject=${encodeURIComponent("Re: your enquiry")}`), 26)
    ].join(""),
    footerHtml: visitorFooter("contact form", data.name)
  });

  return { subject, text, html };
}

export function renderMeetingEmail(data, now = Date.now()) {
  const subject = `[Mintorian meeting request] ${data.name}`;
  const text = [
    "New meeting request from the Mintorian website",
    "This is a request only; no meeting has been booked.",
    `Received ${receivedAt(now)}`,
    "",
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Timezone: ${data.timezone}`,
    `Preferred date/time: ${data.preferredWindow}`,
    "",
    `Topic: ${data.topic}`
  ].join("\n");

  const html = emailDocument({
    preheader: `${data.name} would like to meet: ${snippet(data.topic)}`,
    titleHtml: "New meeting request",
    subline: `From ${data.name}, ${receivedAt(now)}`,
    bodyHtml: [
      // The form never books anything, and the email must not read as though it had.
      cardRow(notice("<strong>This is a request, not a booking.</strong> Nothing has been added to a calendar. Reply to agree a time.", "warn"), 24),
      cardRow(detailRows([
        ["Name", escapeHtml(data.name)],
        ["Email", emailLink(data.email)],
        ["Preferred time", multilineHtml(data.preferredWindow)],
        ["Timezone", escapeHtml(data.timezone)]
      ]), 20),
      cardRow(textPanel("What they want to discuss", multilineHtml(data.topic)), 24),
      cardRow(button(`Reply to ${firstName(data.name)}`, `mailto:${data.email}?subject=${encodeURIComponent("Re: your meeting request")}`), 26)
    ].join(""),
    footerHtml: visitorFooter("meeting request form", data.name)
  });

  return { subject, text, html };
}

export async function sendContactMessage(env, data, idempotencyKey) {
  const { subject, text, html } = renderContactEmail(data);
  return sendViaResend(env, { subject, text, html, replyTo: data.email }, idempotencyKey);
}

export async function sendMeetingRequest(env, data, idempotencyKey) {
  const { subject, text, html } = renderMeetingEmail(data);
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
