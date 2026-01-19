export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;

    const url = new URL(request.url);
    const token = url.searchParams.get("t");
    if (!token) return json({ error: "Missing token" }, 400);
    if (!env.TOKEN_PEPPER) return json({ error: "Server misconfigured: TOKEN_PEPPER missing" }, 500);

    const tokenHash = await sha256Hex(token + env.TOKEN_PEPPER);

    const row = await env.DB.prepare(
      `SELECT
         it.tax_return_id AS tax_return_id,
         it.expires_at AS expires_at,
         it.one_time AS one_time,
         it.used_at AS used_at,
         it.revoked_at AS revoked_at,
         tr.tax_year AS tax_year,
         tr.status AS status,
         c.locale AS locale,
         c.first_name AS first_name,
         c.last_name AS last_name,
         c.email AS email,
         c.mobile AS mobile
       FROM intake_tokens it
       JOIN tax_returns tr ON tr.id = it.tax_return_id
       JOIN clients c ON c.id = tr.client_id
       WHERE it.token_hash = ?
       LIMIT 1`
    ).bind(tokenHash).first<{
      tax_return_id: string;
      expires_at: string;
      one_time: number;
      used_at: string | null;
      revoked_at: string | null;
      tax_year: number;
      status: string;
      locale: string;
      first_name: string;
      last_name: string;
      email: string;
      mobile: string | null;
    }>();

    if (!row) return json({ error: "Invalid token" }, 401);
    if (row.revoked_at) return json({ error: "Token revoked" }, 401);

    const now = Date.now();
    const exp = Date.parse(row.expires_at);
    if (!Number.isFinite(exp) || now > exp) return json({ error: "Token expired" }, 401);

    // If one-time token and already used, block
    if (row.one_time === 1 && row.used_at) {
      return json({ error: "Token already used" }, 401);
    }

    // Mark in_progress (optional; safe)
    if (row.status === "invited") {
      await env.DB.prepare(
        `UPDATE tax_returns SET status = 'in_progress' WHERE id = ?`
      ).bind(row.tax_return_id).run();
    }

    return json({
      ok: true,
      tax_return_id: row.tax_return_id,
      tax_year: row.tax_year,
      locale: row.locale,
      client: {
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        mobile: row.mobile,
      },
      expires_at: row.expires_at,
      one_time: row.one_time === 1,
    }, 200);

  } catch (err: any) {
    return json({ error: "Server error", details: String(err?.message || err) }, 500);
  }
};

type Env = {
  DB: D1Database;
  TOKEN_PEPPER: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
