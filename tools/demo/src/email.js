// Pluggable transactional email. `console` (default) just logs the link — zero setup,
// good for local dev. `resend` posts to the Resend HTTPS API (Node 22 global fetch, no
// npm dep); GCE blocks outbound SMTP (port 25), so a hosted API over 443 is the way.

import { config, REPO_URL } from "./config.js";

/** Email a visitor their demo link via the configured provider. Throws on send failure. */
export async function sendDemoLink(to, link) {
  if (config.emailProvider === "resend") return sendViaResend(to, link);
  // console provider
  console.log(`\n[demo-email] to=${to}\n             ${link}\n`);
}

function compose(link) {
  return {
    subject: "Your yamlover demo is ready",
    text:
      `Open your private yamlover demo:\n\n${link}\n\n` +
      `It stays available for a few days, then is automatically removed.\n\n` +
      `What is yamlover? ${REPO_URL}\n\n` +
      `This is an automated message — please do not reply.`,
    html:
      `<p>Open your private yamlover demo:</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      `<p style="color:#666">It stays available for a few days, then is automatically removed.</p>` +
      `<p style="color:#666">What is yamlover? <a href="${REPO_URL}">${REPO_URL}</a></p>` +
      `<hr style="border:none;border-top:1px solid #eee;margin:16px 0">` +
      `<p style="color:#999;font-size:12px">This is an automated message — please do not reply.</p>`,
  };
}

async function sendViaResend(to, link) {
  if (!config.resendApiKey) throw new Error("RESEND_API_KEY is not set");
  const { subject, text, html } = compose(link);
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: config.emailFrom, to, subject, text, html }),
  });
  if (!resp.ok) {
    throw new Error(`resend ${resp.status}: ${await resp.text().catch(() => "")}`);
  }
}
