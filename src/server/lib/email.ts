// Transactional email.
//
// Pluggable transport behind a single `sendEmail(OutgoingEmail)` seam:
//   - EMAIL_TRANSPORT=resend  -> Resend REST API (talked to directly with
//     fetch, same pattern as lib/turnstile.ts; no SDK dependency).
//   - EMAIL_TRANSPORT=smtp    -> nodemailer, lazy-imported so Resend/none
//     deployments never load it.
//   - unset / none            -> no delivery. Every message is still recorded
//     in an in-memory outbox + logged, so tests can assert and a self-hosted
//     operator can recover a link from the logs.
//
// `emailConfigured()` reports whether a usable transport is set; it gates the
// email-verification wall and whether account-linking is exposed at all.
//
// Back-compat: if EMAIL_TRANSPORT is unset but RESEND_API_KEY is present, we
// assume `resend` (the password-reset feature shipped before EMAIL_TRANSPORT
// existed).

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// Always-populated outbox. Tests read it; production ignores it. Bounded so a
// long-running process can't leak memory if delivery is disabled.
const OUTBOX_CAP = 100;
export const __emailOutbox: OutgoingEmail[] = [];
export function __resetEmailOutbox(): void {
  __emailOutbox.length = 0;
}

// "memory" is a real (not test-only) transport: email is treated as configured
// — so verification flows + linking are active — but delivery only hits the
// in-memory outbox (no network). Handy for dev, CI, and demos where you want
// the flows enabled without wiring a mail server.
type Transport = "resend" | "smtp" | "memory" | "none";

function resendKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}

function smtpUrl(): string | null {
  return process.env.SMTP_URL?.trim() || null;
}
function smtpHost(): string | null {
  return process.env.SMTP_HOST?.trim() || null;
}

// Resolve the configured transport. An explicit EMAIL_TRANSPORT wins; otherwise
// fall back to "resend" when a key is present (back-compat), else "none".
function transport(): Transport {
  const t = process.env.EMAIL_TRANSPORT?.trim().toLowerCase();
  if (t === "smtp") return "smtp";
  if (t === "resend") return "resend";
  if (t === "memory") return "memory";
  if (t === "none") return "none";
  if (!t && resendKey()) return "resend";
  return "none";
}

function fromAddress(): string {
  // Resend's shared onboarding sender works out of the box for testing; real
  // deployments set EMAIL_FROM to a verified domain address.
  return (
    process.env.EMAIL_FROM?.trim() || "Unconference <onboarding@resend.dev>"
  );
}

// True only when the selected transport actually has the config it needs to
// deliver. Drives the verification wall + linking exposure, so it must be
// honest about whether mail can really go out.
export function emailConfigured(): boolean {
  switch (transport()) {
    case "resend":
      return resendKey() !== null;
    case "smtp":
      return smtpUrl() !== null || smtpHost() !== null;
    case "memory":
      return true;
    case "none":
      return false;
  }
}

async function sendViaResend(key: string, msg: OutgoingEmail): Promise<void> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[email] resend delivery failed (${res.status})`, body);
  }
}

async function sendViaSmtp(msg: OutgoingEmail): Promise<void> {
  // Lazy import: nodemailer is only pulled in when SMTP is the active
  // transport, so Resend / no-email deployments never load it.
  const nodemailer = await import("nodemailer");
  const url = smtpUrl();
  const transporter = url
    ? nodemailer.createTransport(url)
    : nodemailer.createTransport({
        host: smtpHost() ?? "localhost",
        port: Number(process.env.SMTP_PORT?.trim() || "587"),
        secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE?.trim() || ""),
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
          : undefined,
      });
  await transporter.sendMail({
    from: fromAddress(),
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
}

// Send (or, when no transport is configured, log + record). Never throws:
// callers in the forgot-password / verification flows must not change their
// response based on delivery success, or they'd leak whether an address exists.
export async function sendEmail(msg: OutgoingEmail): Promise<void> {
  __emailOutbox.push(msg);
  if (__emailOutbox.length > OUTBOX_CAP) __emailOutbox.shift();

  // Hard safety floor: the test suite must NEVER deliver real mail, no matter
  // how email env is configured. `bun test` sets NODE_ENV=test. The outbox
  // above still captures the message for assertions. (A run with a developer's
  // RESEND_API_KEY in .env once fired the whole suite's signup/reset emails at
  // the live Resend API and burned the quota; this makes that impossible even
  // if the hermetic test preload is bypassed.)
  if (process.env.NODE_ENV === "test") return;

  const t = transport();
  if (t === "memory") return; // configured, but delivery is outbox-only
  if (t === "none" || !emailConfigured()) {
    console.warn(
      `[email] no transport configured - not delivering. ` +
        `to=${msg.to} subject=${JSON.stringify(msg.subject)}`,
    );
    return;
  }

  const key = resendKey();
  try {
    if (t === "resend" && key) await sendViaResend(key, msg);
    else if (t === "smtp") await sendViaSmtp(msg);
  } catch (e) {
    // Delivery failure (network/DNS/SMTP). Logged, swallowed - see note above.
    console.error(`[email] ${t} delivery threw`, e);
  }
}

// ----- shared layout -------------------------------------------------------

// Brand + palette. Mirrors the app's accent so email and app feel like one
// product. Colors are explicit (light) because email dark-mode handling is
// wildly inconsistent across clients.
const BRAND = "Unconf";
const COLOR = {
  accent: "#1f6feb",
  fg: "#1f2328",
  muted: "#59636e",
  border: "#d0d7de",
  bg: "#f6f8fa",
  card: "#ffffff",
  codeBg: "#f6f8fa",
} as const;

export interface EmailContent {
  // Short, human subject-line-ish heading (rendered as the card's H1). Plain
  // text — escaped for HTML by renderEmail.
  heading: string;
  // Hidden inbox-preview snippet (the grey text next to the subject). Plain text.
  preheader: string;
  // One or more body paragraphs. Plain text — escaped for HTML.
  intro: string[];
  // A prominent, copyable code (e.g. the 6-digit verification code).
  code?: string;
  // Primary call-to-action button.
  button?: { label: string; url: string };
  // The button's URL again, shown as copy/paste text for clients that strip
  // buttons.
  rawLink?: string;
  // Reassuring small print above the footer (e.g. "didn't request this?").
  footerNote?: string;
}

// Escape text destined for an HTML context. EmailContent text fields are
// treated as plain text (so a conference name or any future dynamic value
// can't inject markup); the only HTML structure is what this function emits.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Single branded shell shared by every transactional email (reset + verify) so
// they look consistent and restyle in one place. Table-based + inline styles
// for email-client compatibility. Plain dashes only (project style forbids
// em-dashes in user-facing copy).
export function renderEmail(c: EmailContent): { html: string; text: string } {
  const introHtml = c.intro
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${
          COLOR.fg
        };">${escapeHtml(p)}</p>`,
    )
    .join("\n            ");

  const codeHtml = c.code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:4px 0 24px;">
              <div style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:10px;color:${
                COLOR.fg
              };background:${COLOR.codeBg};border:1px solid ${
        COLOR.border
      };border-radius:10px;padding:14px 20px 14px 30px;">${escapeHtml(
        c.code,
      )}</div>
            </td></tr></table>`
    : "";

  const buttonHtml = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td align="center" bgcolor="${
        COLOR.accent
      }" style="border-radius:8px;">
              <a href="${
                c.button.url
              }" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(
        c.button.label,
      )}</a>
            </td></tr></table>`
    : "";

  const rawLinkHtml = c.rawLink
    ? `<p style="margin:0 0 4px;font-size:12px;line-height:1.5;color:${COLOR.muted};">Or paste this link into your browser:</p>
            <p style="margin:0 0 4px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${c.rawLink}" style="color:${COLOR.accent};">${c.rawLink}</a></p>`
    : "";

  const footerNoteHtml = c.footerNote
    ? `<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:${
        COLOR.muted
      };">${escapeHtml(c.footerNote)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(c.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:${COLOR.bg};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(
      c.preheader,
    )}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${
      COLOR.bg
    };">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <tr><td style="padding:0 4px 16px;">
            <span style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:${
              COLOR.fg
            };"><span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${
    COLOR.accent
  };vertical-align:middle;margin-right:8px;"></span>${BRAND}</span>
          </td></tr>
          <tr><td style="background:${COLOR.card};border:1px solid ${
    COLOR.border
  };border-radius:12px;padding:32px;">
            <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${
              COLOR.fg
            };">${escapeHtml(c.heading)}</h1>
            ${introHtml}
            ${codeHtml}
            ${buttonHtml}
            ${rawLinkHtml}
          </td></tr>
          <tr><td style="padding:20px 4px 0;">
            ${footerNoteHtml}
            <p style="margin:0;font-size:12px;line-height:1.5;color:${
              COLOR.muted
            };">Sent by ${BRAND}. If this wasn't you, no action is needed.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const textParts = [c.heading, "", ...c.intro];
  if (c.code) textParts.push("", `Code: ${c.code}`);
  if (c.button) textParts.push("", `${c.button.label}: ${c.button.url}`);
  else if (c.rawLink) textParts.push("", c.rawLink);
  if (c.footerNote) textParts.push("", c.footerNote);
  textParts.push(
    "",
    `Sent by ${BRAND}. If this wasn't you, no action is needed.`,
  );
  return { html, text: textParts.join("\n") };
}

// ----- concrete emails -----------------------------------------------------

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
  ttlMinutes: number;
  scopeName?: string;
}): Promise<void> {
  const scope = opts.scopeName ? ` for ${opts.scopeName}` : "";
  const subject = `Reset your password${scope}`;
  const { html, text } = renderEmail({
    heading: subject,
    preheader: `Choose a new password${scope}. This link expires in ${opts.ttlMinutes} minutes.`,
    intro: [
      `We received a request to reset your password${scope}.`,
      `Use the button below to choose a new one. This link expires in ${opts.ttlMinutes} minutes.`,
    ],
    button: { label: "Reset password", url: opts.resetUrl },
    rawLink: opts.resetUrl,
    footerNote:
      "Didn't request this? You can safely ignore this email - your password won't change.",
  });
  await sendEmail({ to: opts.to, subject, html, text });
}

export async function sendVerificationEmail(opts: {
  to: string;
  verifyUrl: string;
  code: string;
  codeTtlMinutes: number;
}): Promise<void> {
  const { html, text } = renderEmail({
    heading: "Confirm your email",
    preheader: `Your confirmation code is ${opts.code} (expires in ${opts.codeTtlMinutes} minutes).`,
    intro: [
      "Welcome! Confirm your email address to finish setting up your account.",
      `Enter this code on the confirmation screen (it expires in ${opts.codeTtlMinutes} minutes):`,
    ],
    code: opts.code,
    button: { label: "Confirm my email", url: opts.verifyUrl },
    rawLink: opts.verifyUrl,
    footerNote: "Didn't create an account? You can safely ignore this email.",
  });
  await sendEmail({ to: opts.to, subject: "Confirm your email", html, text });
}
