// Preview the transactional email templates without sending anything.
//
//   bun run email:preview
//
// Renders each template (with sample data) to ./.email-preview/<name>.html +
// .txt and an index.html, then opens the index in your browser (macOS). Edit
// src/server/lib/email.ts and re-run to iterate on the design.
//
// EMAIL_TRANSPORT is forced to "memory" so this never delivers real mail even
// if your .env has RESEND_API_KEY / SMTP set — every message lands only in the
// in-memory outbox, which we read back out and write to disk.

process.env.EMAIL_TRANSPORT = "memory";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
  __emailOutbox,
  __resetEmailOutbox,
} from "../src/server/lib/email";

const ORIGIN = "https://unconf.example.com";
const OUT = join(process.cwd(), ".email-preview");

const samples: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "password-reset-owner",
    run: () => sendPasswordResetEmail({
      to: "you@example.com",
      resetUrl: `${ORIGIN}/#/auth/reset?token=EXAMPLE_TOKEN`,
      ttlMinutes: 30,
    }),
  },
  {
    name: "password-reset-conference",
    run: () => sendPasswordResetEmail({
      to: "you@example.com",
      resetUrl: `${ORIGIN}/#/c/devconf/reset?token=EXAMPLE_TOKEN`,
      ttlMinutes: 30,
      scopeName: "DevConf 2026",
    }),
  },
  {
    name: "email-verification",
    run: () => sendVerificationEmail({
      to: "you@example.com",
      verifyUrl: `${ORIGIN}/#/auth/verify?token=EXAMPLE_TOKEN`,
      code: "482193",
      codeTtlMinutes: 15,
    }),
  },
];

mkdirSync(OUT, { recursive: true });
const rows: string[] = [];
for (const s of samples) {
  __resetEmailOutbox();
  await s.run();
  const msg = __emailOutbox[__emailOutbox.length - 1];
  if (!msg) throw new Error(`template ${s.name} produced no email`);
  writeFileSync(join(OUT, `${s.name}.html`), msg.html);
  writeFileSync(join(OUT, `${s.name}.txt`), msg.text);
  rows.push(
    `<li><strong>${s.name}</strong> — <code>${msg.subject}</code><br>` +
      `<a href="./${s.name}.html">HTML</a> · <a href="./${s.name}.txt">plain text</a></li>`,
  );
  console.log(`  ${s.name}.html / .txt   (subject: ${msg.subject})`);
}

writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Email previews</title>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5;">
<h1>Email previews</h1>
<p style="color:#59636e;">Sample renders of the transactional email templates. Regenerate with <code>bun run email:preview</code>.</p>
<ul>${rows.join("\n")}</ul>
</body>`,
);

const indexPath = join(OUT, "index.html");
console.log(`\nWrote previews to ${OUT}\nOpen ${indexPath}`);
if (process.platform === "darwin") {
  try { Bun.spawn(["open", indexPath]); } catch { /* best-effort */ }
}
