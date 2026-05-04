/* ================================================================== */
/* MovUP COOKIE BANNER — vanilla JS, sans dépendance                   */
/* À inclure une seule fois sur toutes les pages, après le footer      */
/* ================================================================== */

(function () {
  'use strict';

  const STORAGE_KEY = 'mup_cookie_consent_v1';
  const CONSENT_DURATION_MS = 1000 * 60 * 60 * 24 * 180; // 6 mois CNIL

  // -- État par défaut : tout refusé sauf strictement nécessaire ----
  const DEFAULT_CONSENT = {
    necessary: true,    // toujours actif, non modifiable
    analytics: false,   // mesure d'audience anonyme (Plausible)
    timestamp: null,
  };

  // -- Lecture du consentement ---------------------------------------
  function readConsent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data.timestamp) return null;
      if (Date.now() - data.timestamp > CONSENT_DURATION_MS) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  // -- Écriture du consentement --------------------------------------
  function saveConsent(consent) {
    consent.timestamp = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
    applyConsent(consent);
  }

  // -- Application des choix -----------------------------------------
  function applyConsent(consent) {
    if (consent.analytics) loadPlausible();
    document.dispatchEvent(new CustomEvent('mup:consent', { detail: consent }));
  }

  // -- Chargement Plausible (mesure d'audience UE) -------------------
  function loadPlausible() {
    if (document.querySelector('script[data-domain="movup.io"]')) return;
    const s = document.createElement('script');
    s.defer = true;
    s.dataset.domain = 'movup.io';
    s.src = 'https://plausible.io/js/script.js';
    document.head.appendChild(s);
  }

  // -- Construction du bandeau ---------------------------------------
  function buildBanner() {
    const banner = document.createElement('div');
    banner.id = 'mup-cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-modal', 'false');
    banner.setAttribute('aria-labelledby', 'mup-cookie-title');
    banner.innerHTML = `
      <div class="mup-cookie__content">
        <div class="mup-cookie__text">
          <h2 id="mup-cookie-title">Cookies &amp; vie privée</h2>
          <p>
            MovUP utilise uniquement des cookies strictement nécessaires au
            fonctionnement du Service. La mesure d'audience (Plausible,
            hébergée en Europe, sans cookie tiers) est désactivée par défaut.
            <a href="/cookies.html">En savoir plus</a>.
          </p>
        </div>
        <div class="mup-cookie__actions">
          <button type="button" class="mup-cookie__btn mup-cookie__btn--ghost" data-mup-action="reject">
            Refuser
          </button>
          <button type="button" class="mup-cookie__btn mup-cookie__btn--ghost" data-mup-action="customize">
            Personnaliser
          </button>
          <button type="button" class="mup-cookie__btn mup-cookie__btn--primary" data-mup-action="accept">
            Tout accepter
          </button>
        </div>
      </div>
    `;
    return banner;
  }

  // -- Construction du panneau de personnalisation -------------------
  function buildPanel(currentConsent) {
    const panel = document.createElement('div');
    panel.id = 'mup-cookie-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'mup-cookie-panel-title');
    panel.innerHTML = `
      <div class="mup-cookie-panel__backdrop" data-mup-action="close-panel"></div>
      <div class="mup-cookie-panel__dialog">
        <header>
          <h2 id="mup-cookie-panel-title">Préférences de cookies</h2>
          <button type="button" aria-label="Fermer" data-mup-action="close-panel">×</button>
        </header>

        <section>
          <label class="mup-cookie-panel__row">
            <span>
              <strong>Strictement nécessaires</strong>
              <em>Authentification, sécurité, préférences. Indispensables au Service.</em>
            </span>
            <input type="checkbox" checked disabled>
          </label>

          <label class="mup-cookie-panel__row">
            <span>
              <strong>Mesure d'audience</strong>
              <em>Plausible Analytics, hébergé en Europe, sans cookie tiers, sans collecte d'IP brute.</em>
            </span>
            <input type="checkbox" id="mup-consent-analytics" ${currentConsent.analytics ? 'checked' : ''}>
          </label>
        </section>

        <footer>
          <button type="button" class="mup-cookie__btn mup-cookie__btn--ghost" data-mup-action="reject-all">
            Tout refuser
          </button>
          <button type="button" class="mup-cookie__btn mup-cookie__btn--primary" data-mup-action="save-prefs">
            Enregistrer
          </button>
        </footer>
      </div>
    `;
    return panel;
  }

  // -- Logique du panneau --------------------------------------------
  function openPanel() {
    const current = readConsent() || DEFAULT_CONSENT;
    const panel = buildPanel(current);
    document.body.appendChild(panel);

    panel.addEventListener('click', (e) => {
      const action = e.target.dataset.mupAction;
      if (!action) return;

      if (action === 'close-panel') {
        panel.remove();
      } else if (action === 'reject-all') {
        saveConsent({ ...DEFAULT_CONSENT });
        panel.remove();
        removeBanner();
      } else if (action === 'save-prefs') {
        const analytics = document.getElementById('mup-consent-analytics').checked;
        saveConsent({ necessary: true, analytics });
        panel.remove();
        removeBanner();
      }
    });
  }

  // -- Logique du bandeau --------------------------------------------
  function showBanner() {
    if (document.getElementById('mup-cookie-banner')) return;
    const banner = buildBanner();
    document.body.appendChild(banner);

    banner.addEventListener('click', (e) => {
      const action = e.target.dataset.mupAction;
      if (!action) return;

      if (action === 'accept') {
        saveConsent({ necessary: true, analytics: true });
        removeBanner();
      } else if (action === 'reject') {
        saveConsent({ necessary: true, analytics: false });
        removeBanner();
      } else if (action === 'customize') {
        openPanel();
      }
    });
  }

  function removeBanner() {
    const banner = document.getElementById('mup-cookie-banner');
    if (banner) banner.remove();
  }

  // -- Lien "Gérer mes préférences" dans le footer -------------------
  function bindReopenLinks() {
    document.querySelectorAll('#mup-cookies-reopen, #mup-cookies-open').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        openPanel();
      });
    });
  }

  // -- Initialisation -------------------------------------------------
  function init() {
    const existing = readConsent();
    if (existing) {
      applyConsent(existing);
    } else {
      showBanner();
    }
    bindReopenLinks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
