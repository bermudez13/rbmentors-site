// /functions/api/contact.js

export async function onRequestPost(context) {
  const { request, env } = context;

  const reqId = crypto.randomUUID();
  const log = (...args) => console.log(`[contact ${reqId}]`, ...args);

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const TURNSTILE_SECRET = env.TURNSTILE_SECRET;
    const RESEND_API_KEY = env.RESEND_API_KEY;
    const RESEND_FROM = env.RESEND_FROM;
    const CONTACT_TO = env.CONTACT_TO;
    const CONTACT_SUBJECT_PREFIX = env.CONTACT_SUBJECT_PREFIX || "[RBMentors]";

    log("Env present?", {
      TURNSTILE_SECRET: !!TURNSTILE_SECRET,
      RESEND_API_KEY: !!RESEND_API_KEY,
      RESEND_FROM: RESEND_FROM ? "(set)" : "(missing)",
      CONTACT_TO: CONTACT_TO ? "(set)" : "(missing)",
      CONTACT_SUBJECT_PREFIX,
    });

    if (!TURNSTILE_SECRET || !RESEND_API_KEY || !RESEND_FROM || !CONTACT_TO) {
      return json(
        { ok: false, error: "Server misconfiguration: missing env vars.", reqId },
        500,
        corsHeaders
      );
    }

    // ---- Parse body (JSON, urlencoded, multipart) ----
    const contentType = request.headers.get("content-type") || "";
    let body = {};

    if (contentType.includes("application/json")) {
      body = await request.json().catch(() => ({}));
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      body = Object.fromEntries(form.entries());
    } else {
      log("Unsupported content-type:", contentType);
      return json(
        { ok: false, error: "Unsupported content-type.", contentType, reqId },
        415,
        corsHeaders
      );
    }

    // ---- Extract fields (trim + clamp to safe sizes) ----
    const name = clamp((body.name || "").toString().trim(), 80);
    const email = clamp((body.email || "").toString().trim(), 120);

    // Optional fields
    const phone = clamp((body.phone || "").toString().trim(), 30);
    const language = clamp((body.language || "").toString().trim(), 30);
    const message = clamp((body.message || "").toString().trim(), 1200);

    // Turnstile token
    const turnstileToken = clamp(
      (body["cf-turnstile-response"] || body.turnstileToken || "")
        .toString()
        .trim(),
      5000
    );

    // Honeypot (anti-spam)
    const honeypot = clamp((body.company || "").toString().trim(), 200);

    log("Incoming fields", {
      nameLen: name.length,
      emailLen: email.length,
      phoneLen: phone.length,
      language: language || null,
      messageLen: message.length,
      hasTurnstileToken: !!turnstileToken,
      honeypotFilled: honeypot.length > 0,
      ip: request.headers.get("CF-Connecting-IP") || null,
    });

    // Require minimal fields (message is optional)
    if (!name || !email || !turnstileToken) {
      return json(
        { ok: false, error: "Missing required fields (name, email, captcha).", reqId },
        400,
        corsHeaders
      );
    }

    // Basic email sanity check (not RFC-perfect; good enough to cut obvious junk)
    if (!isValidEmail(email)) {
      return json(
        { ok: false, error: "Invalid email address.", reqId },
        400,
        corsHeaders
      );
    }

    // If honeypot filled: silently accept but do not send email
    if (honeypot) {
      log("Honeypot triggered. Skipping email send.");
      return json({ ok: true, message: "Sent.", reqId }, 200, corsHeaders);
    }

    // ---- Turnstile verify ----
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const tsForm = new FormData();
    tsForm.append("secret", TURNSTILE_SECRET);
    tsForm.append("response", turnstileToken);
    if (ip) tsForm.append("remoteip", ip);

    const tsResp = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: tsForm }
    );

    const tsJson = await tsResp.json().catch(() => null);
    log("Turnstile response", { status: tsResp.status, body: tsJson });

    if (!tsResp.ok || !tsJson?.success) {
      return json(
        {
          ok: false,
          error: "Turnstile verification failed.",
          code: "TURNSTILE_FAILED",
          details: tsJson,
          reqId,
        },
        403,
        corsHeaders
      );
    }

    // ---- Resend ----
    const subject = `${CONTACT_SUBJECT_PREFIX} Web Contact Form`;

    const safePhone = phone ? phone : "(not provided)";
    const safeLanguage = language ? language : "(not selected)";
    const safeMessage = message ? message : "(no message provided)";

    const html = `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(safePhone)}</p>
      <p><strong>Preferred language:</strong> ${escapeHtml(safeLanguage)}</p>
      <p><strong>Message:</strong></p>
      <pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(
        safeMessage
      )}</pre>
      <hr />
      <p><small>Request ID: ${reqId}</small></p>
    `;

    const resendPayload = {
      from: RESEND_FROM,
      to: CONTACT_TO.split(",").map((s) => s.trim()).filter(Boolean),
      subject,
      html,
      reply_to: email,
    };

    log("Resend payload (safe)", {
      from: RESEND_FROM,
      toCount: resendPayload.to.length,
      subject,
      hasReplyTo: !!resendPayload.reply_to,
    });

    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(resendPayload),
    });

    const resendText = await resendResp.text();
    let resendJson = null;
    try {
      resendJson = JSON.parse(resendText);
    } catch (_) {}

    log("Resend response", {
      status: resendResp.status,
      ok: resendResp.ok,
      body: resendJson || resendText,
    });

    if (!resendResp.ok) {
      return json(
        {
          ok: false,
          error: "Resend API error.",
          status: resendResp.status,
          details: resendJson || resendText,
          reqId,
        },
        502,
        corsHeaders
      );
    }

    return json(
      { ok: true, message: "Email sent.", resend: resendJson, reqId },
      200,
      corsHeaders
    );
  } catch (err) {
    console.error(`[contact ${reqId}] unhandled error`, err);
    return json(
      { ok: false, error: "Unhandled server error.", reqId },
      500,
      corsHeaders
    );
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(value, maxLen) {
  const s = String(value || "");
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function isValidEmail(email) {
  if (!email) return false;
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
