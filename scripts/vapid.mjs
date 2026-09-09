#!/usr/bin/env node
// Generate a VAPID (Web Push) P-256 key pair with Node's built-in crypto — no dependencies.
//   node scripts/vapid.mjs
// Put the PUBLIC key in src/config.js (VAPID_PUBLIC_KEY) and the PRIVATE key in the repository
// secret VAPID_PRIVATE_KEY. Never commit the private key.
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });
const raw = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(pub.x, "base64url"),
  Buffer.from(pub.y, "base64url"),
]);

console.log("VAPID_PUBLIC_KEY  (src/config.js, safe to publish):");
console.log(raw.toString("base64url"));
console.log("");
console.log("VAPID_PRIVATE_KEY (GitHub secret, keep private):");
console.log(priv.d);
