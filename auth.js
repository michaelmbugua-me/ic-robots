/**
 * auth.js — One-time OAuth2 Access Token Helper
 *
 * Run this once to get your cTrader access token.
 * The token lasts ~30 days; re-run when it expires.
 *
 * Usage:
 *   node auth.js
 *
 * Prerequisites:
 *   CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET must be set
 *   (either in .env or exported in your terminal)
 *
 * What this does:
 *   1. Prints a URL → open it in your browser
 *   2. You log in with your cTrader ID and approve access
 *   3. Browser redirects to localhost:3000 with an auth code
 *   4. This script exchanges the code for your access token
 *   5. Copy the printed token into your .env file
 */

import http from "http";
import { config } from "./config.js";

const CLIENT_ID     = config.ctraderClientId;
const CLIENT_SECRET = config.ctraderClientSecret;
const REDIRECT_URI  = "http://localhost:3000/callback";
const PORT          = 3000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "\n❌  Missing credentials.\n" +
    "    Set CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET first.\n"
  );
  process.exit(1);
}

// ─── Build the auth URL ───────────────────────────────────────────────────────

const authUrl =
  `https://openapi.ctrader.com/apps/auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=trading`;

console.log("\n" + "═".repeat(62));
console.log("  cTrader — Get Access Token");
console.log("═".repeat(62));
console.log(`
  Step 1: Open this URL in your browser:

  ${authUrl}

  Step 2: Log in with your cTrader ID and click "Allow".

  Step 3: The browser will redirect back here automatically.
`);
console.log("═".repeat(62));
console.log("\n  Waiting for browser redirect...\n");

// ─── Local server to catch the redirect ──────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Waiting for cTrader redirect...");
    return;
  }

  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("No authorisation code received. Please try again.");
    server.close();
    process.exit(1);
  }

  console.log(`  ✓  Authorisation code received.`);
  console.log(`  →  Exchanging for access token...`);

  try {
    const tokenRes = await fetch("https://openapi.ctrader.com/apps/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        grant_type:    "authorization_code",
        code,
        redirect_uri:  REDIRECT_URI,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });

    const text = await tokenRes.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      console.error("\n❌  Server returned invalid JSON response.");
      console.error("    Status:", tokenRes.status, tokenRes.statusText);
      console.error("    Body start:", text.substring(0, 500), "...");
      throw new Error(`Invalid JSON response from server (Status: ${tokenRes.status})`);
    }

    if (data.errorCode || data.error) {
      const errorMsg = data.errorCode ? `${data.errorCode}: ${data.description}` : `${data.error}: ${data.error_description}`;
      throw new Error(errorMsg);
    }

    const expiryDays = Math.round(data.expires_in / 86400);

    console.log("\n" + "═".repeat(62));
    console.log("  ✅  SUCCESS — add these to your .env file:");
    console.log("═".repeat(62));
    console.log(`\n  CTRADER_ACCESS_TOKEN=${data.access_token}`);
    console.log(`  CTRADER_REFRESH_TOKEN=${data.refresh_token}`);
    console.log(`\n  Token expires in: ~${expiryDays} days`);
    console.log("\n" + "═".repeat(62) + "\n");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Auth Success</title></head>
      <body style="font-family:monospace;padding:32px;max-width:600px">
        <h2>✅ Authenticated successfully!</h2>
        <p>Your access token has been printed in the terminal.</p>
        <p>Copy it into your <code>.env</code> file as
           <code>CTRADER_ACCESS_TOKEN</code>.</p>
        <p><strong>You can close this tab.</strong></p>
      </body>
      </html>
    `);

    server.close();
    process.exit(0);

  } catch (err) {
    console.error("\n❌  Token exchange failed:", err.message, "\n");
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Token exchange failed. Check the terminal for details.");
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
