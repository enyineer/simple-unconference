// Phase 2 (account-linking): pluggable email transport selection.
//
// emailConfigured() drives the verification wall + linking exposure, so its
// truth table matters. These tests poke process.env directly; bun runs each
// test file in its own worker process, so env mutation here doesn't leak into
// other files. afterEach restores the unset default within this file.

import { describe, test, expect, afterEach } from "bun:test";
import { emailConfigured, sendEmail, __emailOutbox, __resetEmailOutbox } from "./lib/email";

const ENV_KEYS = ["EMAIL_TRANSPORT", "RESEND_API_KEY", "SMTP_URL", "SMTP_HOST"];
function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("email transport selection", () => {
  afterEach(() => clearEnv());

  test("not configured when nothing is set", () => {
    clearEnv();
    expect(emailConfigured()).toBe(false);
  });

  test("resend assumed when only RESEND_API_KEY is set (back-compat)", () => {
    clearEnv();
    process.env.RESEND_API_KEY = "re_test";
    expect(emailConfigured()).toBe(true);
  });

  test("explicit resend without a key is not configured", () => {
    clearEnv();
    process.env.EMAIL_TRANSPORT = "resend";
    expect(emailConfigured()).toBe(false);
  });

  test("smtp via SMTP_URL", () => {
    clearEnv();
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.SMTP_URL = "smtp://localhost:1025";
    expect(emailConfigured()).toBe(true);
  });

  test("smtp via SMTP_HOST", () => {
    clearEnv();
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.SMTP_HOST = "localhost";
    expect(emailConfigured()).toBe(true);
  });

  test("transport=none ignores a present RESEND_API_KEY", () => {
    clearEnv();
    process.env.EMAIL_TRANSPORT = "none";
    process.env.RESEND_API_KEY = "re_test";
    expect(emailConfigured()).toBe(false);
  });

  test("sendEmail with no transport records to outbox and never throws", async () => {
    clearEnv();
    __resetEmailOutbox();
    await sendEmail({ to: "a@b.com", subject: "s", html: "<p>h</p>", text: "t" });
    expect(__emailOutbox.length).toBe(1);
    expect(__emailOutbox[0]!.to).toBe("a@b.com");
  });
});
