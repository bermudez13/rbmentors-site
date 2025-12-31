// /functions/api/contact.js
// Cloudflare Pages Function: POST /api/contact
// - Turnstile server-side verification
// - Accepts FormData (native form POST) and JSON (fetch)
// - Sends email via Resend
// - Includes logs to debug delivery issues

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function clip(s, max) {
  s = (s ?? "").toString().trim();
  return s.length > max ? s.slice(0, max) : s;
}

async function verifyTurnstile({ secret, token, ip }) {
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  const resp = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  return resp.json();
}

async function sendMailViaResend({ apiKey, from, to, subject, text, replyTo }) {
  const payload = {
    from,
    to: [to],
    subject,
    text,
  };

  // Resend API expects snake_case
  if (replyTo) payload.reply_to = replyTo;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return resp;
}

async function readPayload(request) {
  const ct = request.headers.get("content-type") || "";

  // JSON submission (e.g., fetch with JSON)
  if (ct.includes("application/json")) {
    const data = await request.json().catch(() => null);
    if (!data || typeof data !== "object") return null;

    return {
      company: data.company ?? "",
      name: data.name ?? "",
      email: data.email ?? "",
      phone: data.phone ?? "",
      language: data.language ?? "",
      message: data.message ?? "",
      // allow either name
      turnstile: data["cf-turnstile-response"] ?? data.turnstile ?? "",
    };
  }

  // Default: FormData submission (native form POST)
  const form = await request.formData();
  return {
    company: form.get("company") ?? "",
    name: form.get("name") ?? "",
    email: form.get("email") ?? "",
    phone: form.get("phone") ?? "",
    language: form.get("language") ?? "",
    message: form.get("message") ?? "",
    turnstile: form.get("cf-turnstile-response") ?? "",
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const TURNSTILE_SECRET = env.TURNSTILE_SECRET;
  const CONTACT_TO = env.CONTACT_TO;
  const RESEND_API_KEY = env.RESEND_API_KEY;

  // Set this in Cloudflare env vars if you want a custom FROM:
  // Example: no-reply@rbmentors.com (domain must be verified in Resend).
  const RESEND_FROM = env.RESEND_FROM || "onboarding@resend.dev";

  // Best-effort client IP
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "";

  console.log("RBM /api/contact hit", {
    method: request.method,
    contentType: request.headers.get("content-type") || "",
    ip: ip || "n/a",
    hasTurnstile: !!TURNSTILE_SECRET,
    hasTo: !!CONTACT_TO,
    hasResendKey: !!RESEND_API_KEY,
    resendFrom: RESEND_FROM,
  });

  if (!TURNSTILE_SECRET || !CONTACT_TO || !RESEND_API_KEY) {
    console.log("CONFIG_MISSING", {
      hasTurnstile: !!TURNSTILE_SECRET,
      hasTo: !!CONTACT_TO,
      hasResendKey: !!RESEND_API_KEY,
    });
    return json(
      { ok: false, error: "Server is not configured.", code: "CONFIG_MISSING" },
      500
    );
  }

  let data;
  try {
    data = await readPayload(request);
  } catch (e) {
    console.log("BAD_REQUEST parse failed", String(e));
    return json(
      { ok: false, error: "Invalid request.", code: "BAD_REQUEST" },
      400
    );
  }

  if (!data) {
    console.log("BAD_REQUEST empty payload");
    return json(
      { ok: false, error: "Invalid request.", code: "BAD_REQUEST" },
      400
    );
  }

  // Honeypot
  const hp = clip(data.company, 200);
  if (hp) {
    console.log("HONEYPOT triggered");
    return json({ ok: true }); // pretend success
  }

  const name = clip(data.name, 80);
  const email = clip(data.email, 120);
  const phone = clip(data.phone, 30);
  const language = clip(data.language, 30);
  const message = clip(data.message, 1200);
  const token = clip(data.turnstile, 2000);

  if (!name || !email) {
    console.log("VALIDATION missing required fields", {
      name: !!name,
      email: !!email,
    });
    return json(
      { ok: false, error: "Name and email are required.", code: "VALIDATION" },
      400
    );
  }

  if (!isValidEmail(email)) {
    console.log("VALIDATION invalid email", { email });
    return json(
      { ok: false, error: "Please enter a valid email.", code: "VALIDATION" },
      400
    );
  }

  if (!token) {
    console.log("TURNSTILE_REQUIRED missing token");
    return json(
      { ok: false, error: "Turnstile required.", code: "TURNSTILE_REQUIRED" },
      400
    );
  }

  // Verify Turnstile
  let ts;
  try {
    ts = await verifyTurnstile({ secret: TURNSTILE_SECRET, token, ip });
    console.log("Turnstile verify result", {
      success: !!ts?.success,
      action: ts?.action || null,
      hostname: ts?.hostname || null,
      "error-codes": ts?.["error-codes"] || null,
    });
  } catch (e) {
    console.log("TURNSTILE_FAILED exception", String(e));
    return json(
      {
        ok: false,
        error: "Captcha verification failed.",
        code: "TURNSTILE_FAILED",
      },
      400
    );
  }

  if (!ts?.success) {
    return json(
      {
        ok: false,
        error: "Captcha verification failed.",
        code: "TURNSTILE_FAILED",
      },
      400
    );
  }

  // Build email
  const subjectPrefix = env.CONTACT_SUBJECT_PREFIX || "RBM - New Quote Request";
  const subject = `${subjectPrefix} (${language || "n/a"})`;

  const textLines = [
    "New website contact request",
    "--------------------------",
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || "n/a"}`,
    `Preferred language: ${language || "n/a"}`,
    "",
    "Message:",
    message || "n/a",
    "",
    `IP: ${ip || "n/a"}`,
    "Turnstile: ok",
  ];

  // Send via Resend
  try {
    console.log("RBM sending email via Resend", {
      to: CONTACT_TO,
      from: RESEND_FROM,
    });

    const resp = await sendMailViaResend({
      apiKey: RESEND_API_KEY,
      from: RESEND_FROM,
      to: CONTACT_TO,
      subject,
      text: textLines.join("\n"),
      replyTo: email,
    });

    const respText = await resp.text().catch(() => "");
    console.log("Resend response", resp.status, respText);

    if (!resp.ok) {
      return json(
        { ok: false, error: "Email delivery failed.", code: "EMAIL_FAILED" },
        502
      );
    }
  } catch (e) {
    console.log("EMAIL_FAILED exception", String(e));
    return json(
      { ok: false, error: "Email delivery failed.", code: "EMAIL_FAILED" },
      502
    );
  }

  return json({ ok: true });
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ ok: false, error: "Method not allowed." }, 405);
}
