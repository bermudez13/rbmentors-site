export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "Invalid JSON body" }, 400);

    const {
      tax_year,
      locale = "es",
      first_name,
      last_name,
      email,
      mobile = null,
      occupation = null,
      expires_in_hours = 72,
      one_time = true,
    } = body as Record<string, any>;

    if (!tax_year || typeof tax_year !== "number") return json({ error: "tax_year is required (number)" }, 400);
    if (!first_name || !last_name) return json({ error: "first_name and last_name are required" }, 400);
    if (!email || typeof email !== "string") return json({ error: "email is required" }, 400);
    if (!["es", "en"].includes(locale)) return json({ error: "locale must be 'es' or 'en'" }, 400);
    if (!env.TOKEN_PEPPER) return json({ error: "Server misconfigured: TOKEN_PEPPER missing" }, 500);

    const cleanEmail = email.trim().toLowerCase();
    const expIso = new Date(Date.now() + Number(expires_in_hours) * 60 * 60 * 1000).toISOString();

    // 1) Find or create client (by email)
    const existingClient = await env.DB.prepare(
      `SELECT id FROM clients WHERE email = ? LIMIT 1`
    ).bind(cleanEmail).first<{ id: string }>();

    const clientId = existingClient?.id ?? crypto.randomUUID();

    if (!existingClient) {
      await env.DB.prepare(
        `INSERT INTO clients (id, first_name, last_name, email, mobile, occupation, locale, ssn_last4, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '0000', datetime('now'), datetime('now'))`
      )
        .bind(clientId, first_name.trim(), last_name.trim(), cleanEmail, mobile, occupation, locale)
        .run();
    } else {
      // Non-destructive refresh
      await env.DB.prepare(
        `UPDATE clients
         SET first_name = COALESCE(NULLIF(?, ''), first_name),
             last_name  = COALESCE(NULLIF(?, ''), last_name),
             mobile     = COALESCE(?, mobile),
             occupation = COALESCE(?, occupation),
             locale     = COALESCE(NULLIF(?, ''), locale)
         WHERE id = ?`
      )
        .bind(
          String(first_name ?? "").trim(),
          String(last_name ?? "").trim(),
          mobile,
          occupation,
          locale,
          clientId
        )
        .run();
    }

    // 2) Find or create tax_return (client_id + tax_year)
    const existingTR = await env.DB.prepare(
      `SELECT id FROM tax_returns WHERE client_id = ? AND tax_year = ? LIMIT 1`
    ).bind(clientId, tax_year).first<{ id: string }>();

    const taxReturnId = existingTR?.id ?? crypto.randomUUID();

    if (!existingTR) {
      await env.DB.prepare(
        `INSERT INTO tax_returns (id, client_id, tax_year, status, created_at, updated_at)
         VALUES (?, ?, ?, 'invited', datetime('now'), datetime('now'))`
      )
        .bind(taxReturnId, clientId, tax_year)
        .run();
    }

    // 3) Create token (store only hash)
    const rawToken = generateToken(32);
    const tokenHash = await sha256Hex(rawToken + env.TOKEN_PEPPER);

    await env.DB.prepare(
      `INSERT INTO intake_tokens (id, tax_return_id, token_hash, expires_at, one_time, used_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, datetime('now'))`
    )
      .bind(crypto.randomUUID(), taxReturnId, tokenHash, expIso, one_time ? 1 : 0)
      .run();

    // 4) Build intake URL
    const origin = (env.SITE_ORIGIN || "https://rbmentors.com").replace(/\/+$/, "");
    const intakePath = locale === "en" ? "/en/intake" : "/es/intake";
    const intakeUrl = `${origin}${intakePath}?t=${encodeURIComponent(rawToken)}`;

    // 5) Audit
    await env.DB.prepare(
      `INSERT INTO audit_log (id, tax_return_id, event, ip, user_agent, details_json, created_at)
       VALUES (?, ?, 'invite_created', ?, ?, ?, datetime('now'))`
    )
      .bind(
        crypto.randomUUID(),
        taxReturnId,
        request.headers.get("CF-Connecting-IP"),
        request.headers.get("User-Agent"),
        JSON.stringify({ locale, tax_year, expires_in_hours, one_time })
      )
      .run();

    return json({
      intake_url: intakeUrl,
      tax_return_id: taxReturnId,
      expires_at: expIso,
      one_time: !!one_time,
    }, 200);
  } catch (err: any) {
    return json({ error: "Server error", details: String(err?.message || err) }, 500);
  }
};

type Env = {
  DB: D1Database;
  TOKEN_PEPPER: string;
  SITE_ORIGIN?: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function generateToken(byteLen: number) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
