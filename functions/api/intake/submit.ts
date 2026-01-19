export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const { request, env } = ctx;

    const url = new URL(request.url);
    const token = url.searchParams.get("t");
    if (!token) return json({ error: "Missing token" }, 400);
    if (!env.TOKEN_PEPPER) return json({ error: "Server misconfigured: TOKEN_PEPPER missing" }, 500);

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "Invalid JSON body" }, 400);

    // Extract + basic validation (minimal for now; we harden later)
    const {
      filing_status,

      taxpayer_first_name,
      taxpayer_last_name,
      taxpayer_ssn,
      taxpayer_dob,
      taxpayer_occupation,
      taxpayer_email,
      taxpayer_mobile,

      address_line1,
      address_line2,
      city,
      state,
      zip,

      had_health_insurance,
      digital_assets,

      bank_name,
      bank_routing,
      bank_account,
      bank_account_type,

      was_referred,
      referrer_first_name,
      referrer_last_name,

      spouse,        // object or null
      dependents,    // array
    } = body as Record<string, any>;

    if (!filing_status) return json({ error: "filing_status is required" }, 400);
    if (!taxpayer_first_name || !taxpayer_last_name) return json({ error: "taxpayer name required" }, 400);
    if (!taxpayer_ssn || typeof taxpayer_ssn !== "string") return json({ error: "taxpayer_ssn required" }, 400);
    if (!taxpayer_dob) return json({ error: "taxpayer_dob required" }, 400);
    if (!taxpayer_email) return json({ error: "taxpayer_email required" }, 400);
    if (!address_line1 || !city || !state || !zip) return json({ error: "address required" }, 400);

    // 1) Validate token -> get tax_return_id + client_id
    const tokenHash = await sha256Hex(token + env.TOKEN_PEPPER);

    const tokenRow = await env.DB.prepare(
      `SELECT
         it.tax_return_id AS tax_return_id,
         it.expires_at AS expires_at,
         it.one_time AS one_time,
         it.used_at AS used_at,
         it.revoked_at AS revoked_at,
         tr.client_id AS client_id,
         tr.tax_year AS tax_year
       FROM intake_tokens it
       JOIN tax_returns tr ON tr.id = it.tax_return_id
       WHERE it.token_hash = ?
       LIMIT 1`
    ).bind(tokenHash).first<{
      tax_return_id: string;
      expires_at: string;
      one_time: number;
      used_at: string | null;
      revoked_at: string | null;
      client_id: string;
      tax_year: number;
    }>();

    if (!tokenRow) return json({ error: "Invalid token" }, 401);
    if (tokenRow.revoked_at) return json({ error: "Token revoked" }, 401);

    const now = Date.now();
    const exp = Date.parse(tokenRow.expires_at);
    if (!Number.isFinite(exp) || now > exp) return json({ error: "Token expired" }, 401);

    if (tokenRow.one_time === 1 && tokenRow.used_at) {
      return json({ error: "Token already used" }, 401);
    }

    const taxReturnId = tokenRow.tax_return_id;
    const clientId = tokenRow.client_id;

    // 2) Compute SSN last4 and update clients
    const ssnDigits = String(taxpayer_ssn).replace(/\D/g, "");
    const last4 = ssnDigits.length >= 4 ? ssnDigits.slice(-4) : "0000";

    await env.DB.prepare(
      `UPDATE clients
       SET ssn_last4 = ?, first_name = ?, last_name = ?, email = ?, mobile = ?, occupation = ?
       WHERE id = ?`
    )
      .bind(
        last4,
        String(taxpayer_first_name).trim(),
        String(taxpayer_last_name).trim(),
        String(taxpayer_email).trim().toLowerCase(),
        taxpayer_mobile ?? null,
        taxpayer_occupation ?? null,
        clientId
      )
      .run();

    // 3) Upsert intake (1:1 with tax_return)
    const intakeId = crypto.randomUUID();

    // If intake exists, update; else insert
    const existingIntake = await env.DB.prepare(
      `SELECT id FROM intakes WHERE tax_return_id = ? LIMIT 1`
    ).bind(taxReturnId).first<{ id: string }>();

    if (!existingIntake) {
      await env.DB.prepare(
        `INSERT INTO intakes (
           id, tax_return_id, filing_status,
           taxpayer_first_name, taxpayer_last_name, taxpayer_ssn, taxpayer_dob,
           taxpayer_occupation, taxpayer_email, taxpayer_mobile,
           address_line1, address_line2, city, state, zip,
           had_health_insurance, digital_assets,
           bank_name, bank_routing, bank_account, bank_account_type,
           was_referred, referrer_first_name, referrer_last_name,
           created_at, updated_at
         ) VALUES (
           ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?,
           datetime('now'), datetime('now')
         )`
      )
        .bind(
          intakeId, taxReturnId, filing_status,
          taxpayer_first_name, taxpayer_last_name, taxpayer_ssn, taxpayer_dob,
          taxpayer_occupation ?? null, taxpayer_email, taxpayer_mobile ?? null,
          address_line1, address_line2 ?? null, city, state, zip,
          bool01(had_health_insurance), bool01(digital_assets),
          bank_name ?? null, bank_routing ?? null, bank_account ?? null, bank_account_type ?? null,
          bool01(was_referred), referrer_first_name ?? null, referrer_last_name ?? null
        )
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE intakes SET
           filing_status = ?,
           taxpayer_first_name = ?, taxpayer_last_name = ?, taxpayer_ssn = ?, taxpayer_dob = ?,
           taxpayer_occupation = ?, taxpayer_email = ?, taxpayer_mobile = ?,
           address_line1 = ?, address_line2 = ?, city = ?, state = ?, zip = ?,
           had_health_insurance = ?, digital_assets = ?,
           bank_name = ?, bank_routing = ?, bank_account = ?, bank_account_type = ?,
           was_referred = ?, referrer_first_name = ?, referrer_last_name = ?,
           updated_at = datetime('now')
         WHERE tax_return_id = ?`
      )
        .bind(
          filing_status,
          taxpayer_first_name, taxpayer_last_name, taxpayer_ssn, taxpayer_dob,
          taxpayer_occupation ?? null, taxpayer_email, taxpayer_mobile ?? null,
          address_line1, address_line2 ?? null, city, state, zip,
          bool01(had_health_insurance), bool01(digital_assets),
          bank_name ?? null, bank_routing ?? null, bank_account ?? null, bank_account_type ?? null,
          bool01(was_referred), referrer_first_name ?? null, referrer_last_name ?? null,
          taxReturnId
        )
        .run();
    }

    // 4) Spouse upsert/delete depending on filing_status + spouse object
    const needsSpouse = (filing_status === "married_joint" || filing_status === "married_separate");

    if (needsSpouse && spouse) {
      const s = spouse as Record<string, any>;
      if (!s.first_name || !s.last_name || !s.ssn || !s.dob) {
        return json({ error: "spouse fields required for married filing status" }, 400);
      }

      const existingSpouse = await env.DB.prepare(
        `SELECT id FROM spouses WHERE tax_return_id = ? LIMIT 1`
      ).bind(taxReturnId).first<{ id: string }>();

      if (!existingSpouse) {
        await env.DB.prepare(
          `INSERT INTO spouses (
             id, tax_return_id, first_name, last_name, ssn, dob, occupation, email, mobile, created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')
           )`
        )
          .bind(
            crypto.randomUUID(), taxReturnId,
            s.first_name, s.last_name, s.ssn, s.dob,
            s.occupation ?? null, s.email ?? null, s.mobile ?? null
          )
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE spouses SET
             first_name = ?, last_name = ?, ssn = ?, dob = ?, occupation = ?, email = ?, mobile = ?,
             updated_at = datetime('now')
           WHERE tax_return_id = ?`
        )
          .bind(
            s.first_name, s.last_name, s.ssn, s.dob,
            s.occupation ?? null, s.email ?? null, s.mobile ?? null,
            taxReturnId
          )
          .run();
      }
    } else {
      // Not married, or no spouse provided -> delete spouse row if exists
      await env.DB.prepare(`DELETE FROM spouses WHERE tax_return_id = ?`).bind(taxReturnId).run();
    }

    // 5) Dependents: easiest safe approach for now is replace-all
    await env.DB.prepare(`DELETE FROM dependents WHERE tax_return_id = ?`).bind(taxReturnId).run();

    if (Array.isArray(dependents)) {
      for (const d of dependents) {
        if (!d.first_name || !d.last_name || !d.relationship || !d.dob) continue;

        await env.DB.prepare(
          `INSERT INTO dependents (id, tax_return_id, first_name, last_name, ssn, dob, relationship, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
          .bind(
            crypto.randomUUID(), taxReturnId,
            d.first_name, d.last_name,
            d.ssn ?? null,
            d.dob,
            d.relationship
          )
          .run();
      }
    }

    // 6) Mark tax_return submitted, mark token used (if one_time)
    await env.DB.prepare(
      `UPDATE tax_returns SET status='submitted', submitted_at=datetime('now') WHERE id = ?`
    ).bind(taxReturnId).run();

    if (tokenRow.one_time === 1) {
      await env.DB.prepare(
        `UPDATE intake_tokens SET used_at=datetime('now') WHERE token_hash = ?`
      ).bind(tokenHash).run();
    }

    // 7) Audit
    await env.DB.prepare(
      `INSERT INTO audit_log (id, tax_return_id, event, ip, user_agent, details_json, created_at)
       VALUES (?, ?, 'intake_submitted', ?, ?, ?, datetime('now'))`
    )
      .bind(
        crypto.randomUUID(),
        taxReturnId,
        request.headers.get("CF-Connecting-IP"),
        request.headers.get("User-Agent"),
        JSON.stringify({ tax_year: tokenRow.tax_year })
      )
      .run();

    return json({ ok: true, tax_return_id: taxReturnId }, 200);

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

function bool01(v: any) {
  return v === true || v === 1 || v === "1" || v === "true" ? 1 : 0;
}

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
