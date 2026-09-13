// Shared building blocks for every email the worker sends: the weekly digest, contact
// enquiries and meeting requests. Email clients ignore stylesheets and most modern CSS, so
// everything is nested tables with inline styles. The palette matches the Ask Mintorian
// panel on the site.

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export const COLOUR = Object.freeze({
  ink: "#0a1a3b",
  accent: "#0f66ff",
  accentSoft: "#eaf2ff",
  page: "#f3f6fb",
  card: "#ffffff",
  soft: "#f7f9fc",
  line: "#e3e9f2",
  track: "#edf1f7",
  muted: "#5b6b82",
  amber: "#b54708",
  amberSoft: "#fff3e8",
  green: "#1e8a58",
  greenSoft: "#ebf7f0"
});

export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

// Visitor text keeps its line breaks but never its markup.
export function multilineHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

export function notice(message, tone = "neutral") {
  const palette = {
    good: [COLOUR.greenSoft, COLOUR.green],
    warn: [COLOUR.amberSoft, COLOUR.amber],
    neutral: [COLOUR.soft, COLOUR.muted]
  }[tone] || [COLOUR.soft, COLOUR.muted];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${palette[0]};border-radius:12px;">
    <tr><td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.5;color:${palette[1]};">${message}</td></tr>
  </table>`;
}

// A table-based button, which survives clients that drop padding on links.
export function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="background:${COLOUR.accent};border-radius:10px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td>
  </tr></table>`;
}

// Label and value pairs. Values arrive already escaped, so a caller can link one.
export function detailRows(rows) {
  const body = rows.map(([label, valueHtml]) => `<tr>
      <td width="132" valign="top" style="padding:11px 12px 11px 0;border-top:1px solid ${COLOUR.line};font-family:${FONT};font-size:12px;line-height:1.5;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${COLOUR.muted};">${escapeHtml(label)}</td>
      <td valign="top" style="padding:11px 0;border-top:1px solid ${COLOUR.line};font-family:${FONT};font-size:15px;line-height:1.5;color:${COLOUR.ink};">${valueHtml}</td>
    </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>`;
}

export function textPanel(label, valueHtml) {
  return `<div style="font-family:${FONT};font-size:12px;line-height:1.5;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${COLOUR.muted};">${escapeHtml(label)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;background:${COLOUR.soft};border:1px solid ${COLOUR.line};border-radius:12px;">
      <tr><td style="padding:16px 18px;font-family:${FONT};font-size:15px;line-height:1.6;color:${COLOUR.ink};">${valueHtml}</td></tr>
    </table>`;
}

// A padded content row inside the card.
export function cardRow(innerHtml, paddingTop = 28) {
  return `<tr><td style="padding:${paddingTop}px 32px 0;font-family:${FONT};">${innerHtml}</td></tr>`;
}

// The full document: hidden preheader, dark header with the Ask Mintorian mark, the card
// body, and a muted footer line beneath the card. titleHtml and bodyHtml are trusted
// markup; preheader, eyebrow and subline are plain text and escaped here.
export function emailDocument({ preheader, eyebrow = "Ask Mintorian", titleHtml, subline, bodyHtml, footerHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(eyebrow)}</title>
</head>
<body style="margin:0;padding:0;background:${COLOUR.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOUR.page};">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${COLOUR.card};border:1px solid ${COLOUR.line};border-radius:16px;">
      <tr><td style="background:${COLOUR.ink};padding:28px 32px 26px;border-radius:16px 16px 0 0;font-family:${FONT};">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;background:${COLOUR.accent};border-radius:9px;font-size:15px;font-weight:700;color:#ffffff;">M</td>
          <td style="padding-left:10px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#9ec0ff;">${escapeHtml(eyebrow)}</td>
        </tr></table>
        <div style="margin-top:18px;font-size:26px;line-height:1.2;font-weight:700;color:#ffffff;">${titleHtml}</div>
        ${subline ? `<div style="margin-top:6px;font-size:14px;line-height:1.4;color:#b9c7de;">${escapeHtml(subline)}</div>` : ""}
      </td></tr>
      ${bodyHtml}
      <tr><td style="padding:30px 32px 0;"></td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td style="padding:18px 20px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLOUR.muted};text-align:center;">${footerHtml}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
