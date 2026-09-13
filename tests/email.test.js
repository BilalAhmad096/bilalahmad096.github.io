import test from "node:test";
import assert from "node:assert/strict";
import {
  renderContactConfirmation,
  renderContactEmail,
  renderMeetingConfirmation,
  renderMeetingEmail,
  sendConfirmation
} from "../worker/src/email.js";
import { MARK_URL } from "../worker/src/email-layout.js";

const NOW = Date.parse("2026-09-13T13:32:00Z");

const hostile = {
  name: 'Ana "Eve" Researcher <img src=x onerror=alert(1)>',
  email: "ana@example.org",
  timezone: "Europe/Lisbon",
  preferredWindow: "Tuesday or Wednesday\nafternoon",
  topic: "BESS reliability <script>alert(1)</script>\nand SCOPF screening"
};

test("a meeting request email says plainly that nothing was booked", () => {
  const { subject, text, html } = renderMeetingEmail(hostile, NOW);

  assert.equal(subject, `[Mintorian meeting request] ${hostile.name}`);
  assert.match(text, /no meeting has been booked/i);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /New meeting request/);
  assert.match(html, /This is a request, not a booking/);
  assert.match(html, /13 September 2026 at 14:32/);   // shown in UK time

  // Line breaks survive; markup does not.
  assert.match(html, /Tuesday or Wednesday<br>afternoon/);
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes("&lt;script&gt;"));

  // The reply button opens a draft to the visitor with a subject already filled in.
  assert.ok(html.includes('href="mailto:ana@example.org?subject=Re%3A%20your%20meeting%20request"'));
  assert.match(html, /Reply to Ana/);

  assert.equal(/—/.test(html + text), false);
});

test("a contact enquiry email shows the reason, the message and a reply button", () => {
  const data = { name: "Ada Lovelace", email: "ada@example.org", reason: "Research collaboration", message: "Hello Bilal,\nCould we talk about BESS?" };
  const { subject, text, html } = renderContactEmail(data, NOW);

  assert.equal(subject, "[Mintorian enquiry] Research collaboration, Ada Lovelace");
  assert.match(text, /Reason: Research collaboration/);
  assert.match(html, /New enquiry/);
  assert.match(html, /Research collaboration/);
  assert.match(html, /Hello Bilal,<br>Could we talk about BESS\?/);
  assert.ok(html.includes('href="mailto:ada@example.org?subject=Re%3A%20your%20enquiry"'));
  assert.match(html, /Replying to this email goes straight to Ada/);
  assert.equal(/—/.test(html + text), false);
});

test("every email header carries the chatbot mark, name and tagline", () => {
  const { html } = renderContactEmail({ name: "Ada Lovelace", email: "ada@example.org", reason: "Other", message: "Hello there, Bilal." }, NOW);

  assert.equal(MARK_URL, "https://mintorian.com/img/email/ask-mintorian-mark.png");
  assert.ok(html.includes(`<img src="${MARK_URL}" width="40" height="40" alt=""`));
  // A blocked image still shows as a blue tile rather than an empty box.
  assert.match(html, /background:#0f66ff;border-radius:12px;">\s*<img/);
  assert.match(html, />Ask Mintorian</);
  assert.match(html, /Research &amp; collaboration assistant/);
  assert.equal(/letter-spacing:\.14em/.test(html), false);   // the old uppercase label is gone
});


function memoryKv() {
  const store = new Map();
  return { store, get: async key => store.get(key) ?? null, put: async (key, value) => { store.set(key, value); } };
}

const OWNER_INBOX = "owner.private@gmail.example";

function configuredEnv(overrides = {}) {
  return { RESEND_API_KEY: "re_test", CONTACT_FROM_EMAIL: "assistant@updates.mintorian.com", CONTACT_TO_EMAIL: OWNER_INBOX, RATE_LIMIT_KV: memoryKv(), ...overrides };
}

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return handler(calls.length); };
  try { return { result: await run(), calls }; } finally { globalThis.fetch = original; }
}

test("confirmations use a generic greeting, promise no response time and repeat nothing the visitor typed", () => {
  for (const { subject, text, html } of [renderContactConfirmation(NOW), renderMeetingConfirmation(NOW)]) {
    assert.match(text, /^Hello,/);
    assert.match(html, />Hello,</);
    assert.equal(/within|hours|working day|shortly|as soon as/i.test(text + html), false);
    assert.match(text, /connect@mintorian\.com/);
    assert.match(text, /If that was not you, you can safely ignore this email/);
    assert.match(subject, /has been received$/);
    assert.equal(/—/.test(subject + text + html), false);
  }
  assert.match(renderMeetingConfirmation(NOW).text, /This is a request, not a booking/);
  // The render functions accept no visitor data, so none can ever be echoed.
  assert.equal(renderContactConfirmation.length, 0);
  assert.equal(renderMeetingConfirmation.length, 0);
});

test("a confirmation goes to the visitor with connect@ as reply-to and never exposes the owner's inbox", async () => {
  const env = configuredEnv();
  const { result, calls } = await withFetch(() => Response.json({ id: "email_1" }), () =>
    sendConfirmation(env, { kind: "meeting", recipient: " Ana@Example.org ", idempotencyKey: "meeting-abc" }, NOW));

  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.to, ["ana@example.org"]);
  assert.equal(calls[0].body.reply_to, "connect@mintorian.com");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "meeting-abc:confirmation");
  assert.equal(JSON.stringify(calls[0]).includes(OWNER_INBOX), false);
});

test("an address gets one confirmation a day, and a daily cap protects the sending quota", async () => {
  const env = configuredEnv();
  const send = recipient => sendConfirmation(env, { kind: "contact", recipient, idempotencyKey: `k-${recipient}` }, NOW);

  const { calls } = await withFetch(() => Response.json({ id: "ok" }), async () => {
    assert.deepEqual(await send("victim@example.org"), { sent: true });
    assert.deepEqual(await send("VICTIM@example.org"), { sent: false, reason: "already_confirmed_today" });
  });
  assert.equal(calls.length, 1);

  // The raw address is never stored, only a salted hash of it.
  assert.equal([...env.RATE_LIMIT_KV.store.keys()].some(key => key.includes("victim")), false);

  env.RATE_LIMIT_KV.store.set(`confirm:total:${Math.floor(NOW / 86400000)}`, "40");
  const capped = await withFetch(() => Response.json({ id: "ok" }), () => send("someone.new@example.org"));
  assert.deepEqual(capped.result, { sent: false, reason: "daily_cap" });
  assert.equal(capped.calls.length, 0);
});

test("a confirmation never throws, and does nothing without its configuration", async () => {
  const offline = await withFetch(() => { throw new Error("network down"); }, () =>
    sendConfirmation(configuredEnv(), { kind: "contact", recipient: "ada@example.org" }, NOW));
  assert.deepEqual(offline.result, { sent: false, reason: "error" });

  const rejected = await withFetch(() => new Response("bad", { status: 422 }), () =>
    sendConfirmation(configuredEnv(), { kind: "contact", recipient: "ada@example.org" }, NOW));
  assert.deepEqual(rejected.result, { sent: false, reason: "delivery_failed" });

  assert.equal((await sendConfirmation(configuredEnv({ RATE_LIMIT_KV: undefined }), { kind: "contact", recipient: "ada@example.org" }, NOW)).reason, "not_configured");
  assert.equal((await sendConfirmation(configuredEnv(), { kind: "contact", recipient: "not an email" }, NOW)).reason, "invalid_recipient");
});
