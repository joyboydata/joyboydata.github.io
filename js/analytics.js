/*
  Joyboydata lightweight analytics

  Goals:
  - Privacy-conscious (no cookies/localStorage; no PII beyond explicit outbound targets like mailto/wa).
  - Minimal dependencies.
  - Works with existing GA4 gtag hook (if present) and degrades safely if absent.

  Event names follow content/positioning.md taxonomy.
*/

(function () {
  "use strict";

  function safeStr(value) {
    if (value === undefined || value === null) return "";
    return String(value);
  }

  function getUtmParams() {
    var params = new URLSearchParams(window.location.search);
    var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content"];
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var val = params.get(key);
      if (val) out[key] = val;
    }
    return out;
  }

  function getLanguage() {
    return safeStr(document.documentElement.getAttribute("lang") || "");
  }

  function getDeviceType() {
    // Simple heuristic; avoids fingerprinting.
    return window.matchMedia && window.matchMedia("(max-width: 720px)").matches
      ? "mobile"
      : "desktop";
  }

  function baseProps() {
    var props = {
      page_path: safeStr(window.location.pathname),
      page_title: safeStr(document.title),
      referrer: safeStr(document.referrer),
      language: getLanguage(),
      device_type: getDeviceType(),
    };
    var utm = getUtmParams();
    for (var k in utm) props[k] = utm[k];
    return props;
  }

  function sendEvent(name, props) {
    var payload = baseProps();
    if (props) {
      for (var k in props) payload[k] = props[k];
    }

    // Prefer GA4 gtag if present.
    if (typeof window.gtag === "function") {
      window.gtag("event", name, payload);
      return;
    }

    // Fallback: no-op (keeps site functional without analytics).
  }

  function sendPageView() {
    // For GA4: since base template disables auto page_view.
    if (typeof window.gtag === "function") {
      window.gtag("event", "page_view", baseProps());
      return;
    }

    // Otherwise just emit our own page_view for completeness.
    sendEvent("page_view", null);
  }

  function shouldTreatAsOutbound(href) {
    if (!href) return false;
    if (href.indexOf("mailto:") === 0) return false;
    if (href.indexOf("tel:") === 0) return false;
    if (href.indexOf("#") === 0) return false;
    if (href.indexOf("/") === 0) return false;
    if (href.indexOf(window.location.origin) === 0) return false;
    return href.indexOf("http://") === 0 || href.indexOf("https://") === 0;
  }

  function setupCtaClickTracking() {
    document.addEventListener(
      "click",
      function (e) {
        var el = e.target;
        if (!el) return;

        // Walk up to a clickable element.
        var a = el.closest ? el.closest("a, button") : null;
        if (!a) return;

        var ctaId = a.getAttribute("data-cta-id");
        var ctaLabel = a.getAttribute("data-cta-label") || a.textContent || "";
        var ctaLocation = a.getAttribute("data-cta-location") || "";
        var ctaType = a.getAttribute("data-cta-type") || "";

        var href = a.getAttribute("href") || "";

        if (ctaId) {
          sendEvent("cta_click", {
            cta_id: safeStr(ctaId),
            cta_label: safeStr(ctaLabel).trim().slice(0, 120),
            cta_location: safeStr(ctaLocation),
            cta_type: safeStr(ctaType),
          });
        }

        if (href.indexOf("mailto:") === 0) {
          var email = href.replace(/^mailto:/i, "").split("?")[0];
          sendEvent("contact_click_email", {
            email_address: safeStr(email),
            cta_location: safeStr(ctaLocation || ""),
          });
          return;
        }

        if (href.indexOf("https://wa.me/") === 0 || href.indexOf("https://api.whatsapp.com/") === 0) {
          // Best-effort extraction.
          var waNumber = "";
          try {
            var u = new URL(href);
            if (u.hostname === "wa.me") waNumber = u.pathname.replace("/", "");
          } catch (_) {}
          sendEvent("contact_click_whatsapp", {
            wa_number: safeStr(waNumber),
            cta_location: safeStr(ctaLocation || ""),
            prefill_template_id: safeStr(a.getAttribute("data-wa-template-id") || ""),
          });
          return;
        }

        if (shouldTreatAsOutbound(href)) {
          try {
            var outUrl = new URL(href);
            sendEvent("outbound_click", {
              outbound_domain: safeStr(outUrl.hostname),
              outbound_path: safeStr(outUrl.pathname),
              link_label: safeStr(ctaLabel).trim().slice(0, 120),
            });
          } catch (_) {
            // Ignore URL parse failure.
          }
        }
      },
      { capture: true }
    );
  }

  function setupSectionViewTracking() {
    if (!("IntersectionObserver" in window)) return;

    var observed = new Set();
    var observer = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (!entry.isIntersecting) continue;
          var node = entry.target;

          var kind = node.getAttribute("data-track");
          var id = node.getAttribute("data-track-id") || node.id || "";
          if (!kind || !id) continue;

          var key = kind + ":" + id;
          if (observed.has(key)) continue;
          observed.add(key);

          if (kind === "service") {
            sendEvent("service_view", {
              service_id: safeStr(id),
              service_location: safeStr(node.getAttribute("data-track-location") || ""),
            });
          } else if (kind === "proof") {
            sendEvent("proof_view", {
              proof_id: safeStr(id),
              proof_type: safeStr(node.getAttribute("data-proof-type") || ""),
            });
          }
        }
      },
      { threshold: 0.35 }
    );

    var nodes = document.querySelectorAll("[data-track][data-track-id]");
    for (var j = 0; j < nodes.length; j++) observer.observe(nodes[j]);
  }

  function sendContactView() {
    var isContact = window.location.pathname.replace(/\/$/, "") === "/contact";
    if (!isContact) return;

    var src = "";
    try {
      var ref = document.referrer;
      if (ref) {
        var u = new URL(ref);
        if (u.origin === window.location.origin) src = u.pathname;
      }
    } catch (_) {}

    sendEvent("contact_view", { source_page_path: safeStr(src) });
  }

  function setupScrollDepth() {
    // Optional light scroll depth (25/50/75/90) without storing user identifiers.
    var thresholds = [25, 50, 75, 90];
    var sent = {};
    function onScroll() {
      var doc = document.documentElement;
      var scrollTop = doc.scrollTop || document.body.scrollTop || 0;
      var scrollHeight = doc.scrollHeight || document.body.scrollHeight || 1;
      var clientHeight = doc.clientHeight || window.innerHeight || 1;
      var max = Math.max(scrollHeight - clientHeight, 1);
      var pct = Math.round((scrollTop / max) * 100);
      for (var i = 0; i < thresholds.length; i++) {
        var t = thresholds[i];
        if (pct >= t && !sent[t]) {
          sent[t] = true;
          sendEvent("scroll_depth", { percent: t });
        }
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // Boot
  sendPageView();
  sendContactView();
  setupCtaClickTracking();
  setupSectionViewTracking();
  setupScrollDepth();
})();
