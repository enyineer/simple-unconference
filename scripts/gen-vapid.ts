// Generate a fresh VAPID keypair for Web Push.
//
//   bun run scripts/gen-vapid.ts
//
// Prints a public/private key pair. Set them once and keep them stable — a new
// keypair invalidates every existing browser subscription. Wire them into the
// server env (.env locally, the Helm `webPush` values / secret in prod):
//
//   VAPID_PUBLIC_KEY=<public>
//   VAPID_PRIVATE_KEY=<private>   # secret — never commit / expose to clients
//   VAPID_SUBJECT=mailto:you@example.com   # optional; defaults to APP_URL
//
// The public key is safe to expose (config.get sends it to the SPA); the
// private key must stay server-side.

import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("VAPID keypair generated. Add these to your server env:\n");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:admin@example.com`);
console.log(
  "\nKeep the private key secret and the pair stable — rotating it drops every existing subscription.",
);
