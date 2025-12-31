// /assets/js/main.js

// Footer year
const yearEl = document.getElementById("year");
if (yearEl) {
  yearEl.textContent = String(new Date().getFullYear());
}

// Scroll to top button
const scrollTopBtn = document.getElementById("scrollTopBtn");
if (scrollTopBtn) {
  window.addEventListener("scroll", () => {
    scrollTopBtn.style.display = window.scrollY > 300 ? "block" : "none";
  });

  scrollTopBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// Contact form (AJAX + UX)
const contactForm = document.querySelector(".contact-form");
if (contactForm) {
  const btn = contactForm.querySelector('button[type="submit"]');
  const statusEl = contactForm.querySelector(".form-status");

  const isSpanish =
    (document.documentElement.lang || "").toLowerCase().startsWith("es") ||
    window.location.pathname.startsWith("/es/");

  const text = {
    sending: isSpanish ? "Enviando..." : "Sending...",
    sent: isSpanish
      ? "Listo. Recibí tu solicitud. Te responderé por email pronto."
      : "Done. I received your request. I’ll reply by email soon.",
    error: isSpanish
      ? "No se pudo enviar. Intenta de nuevo en unos minutos."
      : "Could not send. Please try again in a few minutes.",
    network: isSpanish
      ? "Error de red. Revisa tu conexión e intenta de nuevo."
      : "Network error. Check your connection and try again.",
    timeout: isSpanish
      ? "La solicitud tardó demasiado. Intenta de nuevo."
      : "Request timed out. Please try again.",
    rateLimit: isSpanish
      ? "Demasiados intentos. Espera una hora e inténtalo de nuevo."
      : "Too many attempts. Please wait an hour and try again.",
    turnstile: isSpanish
      ? "Verifica el captcha y vuelve a intentar."
      : "Please complete the captcha and try again.",
    invalid: isSpanish
      ? "Revisa los campos requeridos (nombre y email)."
      : "Please check required fields (name and email).",
    invalidEmail: isSpanish
      ? "El email no parece válido."
      : "Email doesn't look valid.",
  };

  function setStatus(message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.classList.remove("is-success", "is-error");
    if (kind === "success") statusEl.classList.add("is-success");
    if (kind === "error") statusEl.classList.add("is-error");
  }

  function setLoading(loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.textContent = loading ? text.sending : btn.dataset.originalText;
  }

  function isValidEmail(email) {
    const v = String(email || "").trim();
    if (!v) return false;
    if (v.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  function resetTurnstileIfPresent() {
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      try {
        window.turnstile.reset();
      } catch {
        // ignore
      }
    }
  }

  let inFlight = false;

  contactForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (inFlight) return;

    setStatus("", null);

    const name =
      contactForm.querySelector('input[name="name"]')?.value?.trim() || "";
    const email =
      contactForm.querySelector('input[name="email"]')?.value?.trim() || "";

    if (!name || !email) {
      setStatus(text.invalid, "error");
      return;
    }
    if (!isValidEmail(email)) {
      setStatus(text.invalidEmail, "error");
      return;
    }

    // Fast-fail if Turnstile not completed (hidden input added by Turnstile)
    const ts =
      contactForm
        .querySelector('input[name="cf-turnstile-response"]')
        ?.value?.trim() || "";
    if (!ts) {
      setStatus(text.turnstile, "error");
      return;
    }

    inFlight = true;
    setLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const formData = new FormData(contactForm);

      const res = await fetch(contactForm.action || "/api/contact", {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }

      if (res.ok && data && data.ok) {
        setStatus(text.sent, "success");
        contactForm.reset();
        resetTurnstileIfPresent();
        return;
      }

      // Specific handling by status/code
      if (res.status === 429 || data?.code === "RATE_LIMIT") {
        setStatus(text.rateLimit, "error");
        return;
      }

      const isTurnstile =
        data?.code === "TURNSTILE_REQUIRED" ||
        data?.code === "TURNSTILE_FAILED" ||
        res.status === 403 ||
        (typeof data?.error === "string" &&
          data.error.toLowerCase().includes("turnstile"));

      if (isTurnstile) {
        setStatus(text.turnstile, "error");
        return;
      }

      // Fallback error (prefer server message if present)
      setStatus(data?.error || text.error, "error");
    } catch (err) {
      if (err && err.name === "AbortError") {
        setStatus(text.timeout, "error");
      } else {
        setStatus(text.network, "error");
      }
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
      inFlight = false;
    }
  });
}
