(async function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("t");

  const loading = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const form = document.getElementById("intake-form");

  if (!token) {
    loading.style.display = "none";
    errorEl.textContent = "Invalid or missing link.";
    errorEl.style.display = "block";
    return;
  }

  try {
    const res = await fetch(`/api/intake/session?t=${encodeURIComponent(token)}`);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Invalid or expired link");
    }

    // Prefill
    document.getElementById("tax-year").textContent = data.tax_year;
    form.taxpayer_first_name.value = data.client.first_name || "";
    form.taxpayer_last_name.value = data.client.last_name || "";

    loading.style.display = "none";
    form.style.display = "block";

  } catch (err) {
    loading.style.display = "none";
    errorEl.textContent = err.message || "Access denied";
    errorEl.style.display = "block";
  }
})();

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    filing_status: "single",

    taxpayer_first_name: form.taxpayer_first_name.value.trim(),
    taxpayer_last_name: form.taxpayer_last_name.value.trim(),
    taxpayer_ssn: form.taxpayer_ssn.value.trim(),
    taxpayer_dob: form.taxpayer_dob.value,
    taxpayer_occupation: null,
    taxpayer_email: data.client.email,
    taxpayer_mobile: data.client.mobile,

    address_line1: "123 Main St",
    address_line2: null,
    city: "Miami",
    state: "FL",
    zip: "33101",

    had_health_insurance: true,
    digital_assets: false,

    bank_name: "Chase",
    bank_routing: "021000021",
    bank_account: "1234567890",
    bank_account_type: "checking",

    was_referred: false,
    referrer_first_name: null,
    referrer_last_name: null,

    spouse: null,
    dependents: []
  };

  const res = await fetch(`/api/intake/submit?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const out = await res.json();
  if (!res.ok) {
    alert(out.error || "Submit failed");
    return;
  }

  alert("Submitted OK");
});
