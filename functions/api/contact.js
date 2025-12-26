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
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function clip(s, max) {
  s = (s || "").toString().trim();
  return s.length > max ? s.slice(0, max) : s;
}

async function verifyTurnstile({ secret, token, ip }) {
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return resp.json();
}

async function sendWithResend({ apiKey, from, to, subject, text, replyTo }) {
  const payload = {
    from,
    to: [to],
    subject,
    text,
    ...(replyTo ? { reply_to: replyTo } : {}),
  };

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

export async function onRequestPost(context) {
  const { request, env } = context;

  const TURNSTILE_SECRET = env.TURNSTILE_SECRET;
  const CONTACT_TO = env.CONTACT_TO;
  const RESEND_API_KEY = env.RESEND_API_KEY;

  // If you haven't verified your domain in Resend yet, keep the default:
  // "onboarding@resend.dev" (works for testing).
  // Later you can set RESEND_FROM="no-reply@rbmentors.com" after domain verification.
  const RESEND_FROM = env.RESEND_FROM || "onboarding@resend.dev";

  if (!TURNSTILE_SECRET || !CONTACT_TO || !RESEND_API_KEY) {
    return json({ ok: false, error: "Server is not configured.", code: "CONFIG_MISSING" }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Invalid request.", code: "BAD_REQUEST" }, 400);
  }

  // Honeypot
  const hp = clip(form.get("company"), 200);
  if (hp) return json({ ok: true });

  const name = clip(form.get("name"), 80);
  const email = clip(form.get("email"), 120);
  const phone = clip(form.get("phone"), 30);
  const language = clip(form.get("language"), 30);
  const message = clip(form.get("message"), 1200);

  if (!name || !email) {
    return json({ ok: false, error: "Name and email are required.", code: "VALIDATION" }, 400);
  }
  if (!isValidEmail(email)) {
    return json({ ok: false, error: "Please enter a valid email.", code: "VALIDATION" }, 400);
  }

  const token = clip(form.get("cf-turnstile-response"), 2000);
  if (!token) {
    return json({ ok: false, error: "Turnstile required.", code: "TURNSTILE_REQUIRED" }, 400);
  }

  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "";

  let ts;
  try {
    ts = await verifyTurnstile({ secret: TURNSTILE_SECRET, token, ip });
  } catch {
    return json({ ok: false, error: "Captcha verification failed.", code: "TURNSTILE_FAILED" }, 400);
  }

  if (!ts.success) {
    return json({ ok: false, error: "Captcha verification failed.", code: "TURNSTILE_FAILED" }, 400);
  }

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

  try {
    const resp = await sendWithResend({
      apiKey: RESEND_API_KEY,
      from: RESEND_FROM,
      to: CONTACT_TO,
      subject,
      text: textLines.join("\n"),
      replyTo: email,
    });

    if (!resp.ok) {
      const details = await resp.text().catch(() => "");
      console.log("Resend failed:", resp.status, details);
      return json({ ok: false, error: "Email delivery failed.", code: "EMAIL_FAILED" }, 502);
    }
  } catch (err) {
    console.log("Resend exception:", err);
    return json({ ok: false, error: "Email delivery failed.", code: "EMAIL_FAILED" }, 502);
  }

  return json({ ok: true });
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ ok: false, error: "Method not allowed." }, 405);
}
