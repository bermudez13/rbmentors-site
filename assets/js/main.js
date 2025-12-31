// Footer year
const yearEl = document.getElementById("year");
if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
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

  const isSpanish = (document.documentElement.lang || "").toLowerCase().startsWith("es")
    || window.location.pathname.startsWith("/es/");

  const text = {
    sending: isSpanish ? "Enviando..." : "Sending...",
    sent: isSpanish ? "Listo. Recibí tu solicitud. Te responderé por email pronto." : "Done. I received your request. I’ll reply by email soon.",
    error: isSpanish ? "No se pudo enviar. Intenta de nuevo en unos minutos." : "Could not send. Please try again in a few minutes.",
    turnstile: isSpanish ? "Verifica el captcha y vuelve a intentar." : "Please complete the captcha and try again.",
    invalid: isSpanish ? "Revisa los campos requeridos (nombre y email)." : "Please check required fields (name and email).",
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

  contactForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("", null);

    // HTML5 validity (since you set novalidate, we do it manually)
    const name = contactForm.querySelector('input[name="name"]')?.value?.trim() || "";
    const email = contactForm.querySelector('input[name="email"]')?.value?.trim() || "";
    if (!name || !email) {
      setStatus(text.invalid, "error");
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData(contactForm);

      const res = await fetch(contactForm.action || "/api/contact", {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" },
      });

      const raw = await res.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}

      if (res.ok && data && data.ok) {
        setStatus(text.sent, "success");
        contactForm.reset();
        if (window.turnstile && typeof window.turnstile.reset === "function") {
          window.turnstile.reset();
        }
      } else {
        // Turnstile: soporta backend con "code" o con status/error
        const isTurnstile =
          data?.code === "TURNSTILE_REQUIRED" ||
          data?.code === "TURNSTILE_FAILED" ||
          res.status === 403 ||
          (typeof data?.error === "string" && data.error.toLowerCase().includes("turnstile"));

        if (isTurnstile) {
          setStatus(text.turnstile, "error");
        } else {
          setStatus(data?.error || text.error, "error");
        }
      }
    } catch (err) {
      setStatus(text.error, "error");
    } finally {
      setLoading(false);
    }

  });
}
