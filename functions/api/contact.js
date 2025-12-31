// /functions/api/contact.js

export async function onRequestPost(context) {
  const { request, env } = context;

  const reqId = crypto.randomUUID();
  const log = (...args) => console.log(`[contact ${reqId}]`, ...args);

  // CORS (si tu frontend y backend están en el mismo dominio, igual no molesta)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    // Handle preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ---- Env vars (Pages Functions => env.*) ----
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
        { ok: false, error: "Server misconfiguration: missing env vars." },
        500,
        corsHeaders
      );
    }

    // ---- Parse body ----
    let body;
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      body = await request.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      body = Object.fromEntries(form.entries());
    } else {
      return json(
        { ok: false, error: "Unsupported content-type." },
        415,
        corsHeaders
      );
    }

    const name = (body.name || "").toString().trim();
    const email = (body.email || "").toString().trim();
    const message = (body.message || "").toString().trim();
    const turnstileToken =
      (body["cf-turnstile-response"] || body.turnstileToken || "")
        .toString()
        .trim();

    log("Incoming fields", {
      nameLen: name.length,
      emailLen: email.length,
      messageLen: message.length,
      hasTurnstileToken: !!turnstileToken,
      ip: request.headers.get("CF-Connecting-IP") || null,
    });

    if (!name || !email || !message || !turnstileToken) {
      return json(
        { ok: false, error: "Missing required fields." },
        400,
        corsHeaders
      );
    }

    // ---- Turnstile verify (server-side) ----
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
        { ok: false, error: "Turnstile verification failed.", details: tsJson },
        403,
        corsHeaders
      );
    }

    // ---- Send via Resend ----
    // Resend suele aceptar "Name <email@domain>"
    // Recomendado: RESEND_FROM = "Right Business Mentors <no-reply@rbmentors.com>"
    const subject = `${CONTACT_SUBJECT_PREFIX} Contact form submission`;

    const html = `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Message:</strong></p>
      <pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(
        message
      )}</pre>
      <hr />
      <p><small>Request ID: ${reqId}</small></p>
    `;

    const resendPayload = {
      from: RESEND_FROM,
      to: CONTACT_TO.split(",").map((s) => s.trim()).filter(Boolean),
      subject,
      html,
      // Para que puedas responder directo al cliente
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
    } catch (_) {
      // keep text
    }

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
      {
        ok: true,
        message: "Email sent.",
        resend: resendJson,
        reqId,
      },
      200,
      corsHeaders
    );
  } catch (err) {
    console.error(`[contact] unhandled error`, err);
    return json(
      { ok: false, error: "Unhandled server error." },
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

// Simple HTML escaping
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
