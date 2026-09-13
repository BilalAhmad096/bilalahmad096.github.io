import test from "node:test";
import assert from "node:assert/strict";
import { renderContactEmail, renderMeetingEmail } from "../worker/src/email.js";

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
