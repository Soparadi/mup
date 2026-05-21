// Composant front du cycle de résiliation — injecté sur toutes les pages app.
// Discrimine sur le champ app_state (server-side via deriveAppState, H5a) :
//   - trial_expired / grace_expired → popup bloquant plein écran non
//     fermable (cards plans + lien export RGPD + déconnexion).
//   - grace_active → bandeau β non-bloquant (état dégradé voulu, lecture
//     seule 7j post-résiliation). L'utilisateur continue à consulter.
//   - active / trial_active → rien.
//
// VERROU DOCTRINAIRE (D4 H5b) : dans le popup grace_expired, le lien
// « Télécharger mes données » du footer reste cliquable. Le mur bloque
// le réabonnement, jamais l'accès à l'export RGPD (article 20).
//
// 2 sources de signal :
//   1. Bootcheck au load : fetch /api/user/me → data.app_state.
//   2. Intercepteur fetch global : sur 402, discrimine sur body.error
//      (trial_expired / grace_expired / grace_active). Pour grace_active
//      sur mutation : toast court fermable, l'utilisateur reste sur sa
//      page en lecture.
//
// Coexistence avec auth-401-handler.js : trial-modal patche fetch EN
// PREMIER (ordre du document, deux scripts defer), auth-401 capture le
// fetch déjà patché → chaînage propre, pas d'écrasement.
//
// Style : préfixes .tem- (modal) + .tem-banner-* + .tem-mut-* (collision
// nulle avec les CSS des pages app). Palette pipeline figée — ambre
// #F59E0B pour le bandeau β (état dégradé voulu, distinct du toast
// auth-401 sombre #1D1D1F qui signale une erreur).

(function () {
  'use strict'

  // Évite double init si le script est chargé plusieurs fois
  if (window.__TEM_INITED) return
  window.__TEM_INITED = true

  var PLANS = [
    { key: 'demarrage', name: 'Démarrage', monthly: 24, annual: 20, annualTotal: 240, color: '#0BBCD4', soft: 'rgba(11,188,212,.12)' },
    { key: 'activite',  name: 'Activité',  monthly: 34, annual: 28, annualTotal: 340, color: '#1D8348', soft: 'rgba(29,131,72,.12)' },
    { key: 'croisiere', name: 'Croisière', monthly: 44, annual: 37, annualTotal: 440, color: '#1D8348', soft: 'rgba(29,131,72,.12)' }
  ]
  var VALID_PLANS = ['demarrage', 'activite', 'croisiere']

  // Plan présélectionné (badge "Le plus choisi" + scale 1.02) :
  //   - intended_plan du user (lu via window.__USER__ injecté serveur-side)
  //     si présent et valide
  //   - fallback 'activite' (plan central, le plus représentatif)
  var preferredPlan = (function () {
    var u = window.__USER__
    var ip = u && u.intended_plan
    return (ip && VALID_PLANS.indexOf(ip) !== -1) ? ip : 'activite'
  })()

  var STYLE_ID = 'tem-modal-style'
  var OVERLAY_ID = 'tem-modal-overlay'
  var BANNER_ID = 'tem-banner'
  var MUT_TOAST_ID = 'tem-mut-toast'
  var billingCycle = 'monthly'

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    var s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = '\
#tem-modal-overlay{position:fixed;inset:0;background:rgba(10,10,10,.78);backdrop-filter:blur(4px);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow-y:auto;font-family:Geist,-apple-system,sans-serif}\
.tem-card{background:#fff;border-radius:18px;max-width:920px;width:100%;padding:40px 36px;box-shadow:0 24px 64px rgba(0,0,0,.3)}\
@media (max-width:640px){.tem-card{padding:28px 22px}}\
.tem-h1{font-size:30px;font-weight:800;letter-spacing:-.6px;color:#0A0A0A;text-align:center;margin:0 0 8px;line-height:1.15}\
@media (max-width:640px){.tem-h1{font-size:24px}}\
.tem-sub{font-size:15px;color:#6E6E73;text-align:center;margin:0 auto 24px;max-width:520px;line-height:1.55}\
.tem-toggle-wrap{display:flex;justify-content:center;margin-bottom:24px}\
.tem-toggle{display:inline-flex;background:#F6F6F4;border-radius:999px;padding:5px;gap:4px}\
.tem-tbtn{padding:9px 22px;border:none;background:transparent;border-radius:999px;font-family:inherit;font-size:13px;font-weight:500;color:#5A5A5A;cursor:pointer}\
.tem-tbtn.active{background:#0A0A0A;color:#fff}\
.tem-tbtn .tem-disc{color:#1D8348;font-weight:600;font-size:12px;margin-left:4px}\
.tem-tbtn.active .tem-disc{color:#fff}\
.tem-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:22px}\
@media (max-width:760px){.tem-grid{grid-template-columns:1fr;max-width:380px;margin-left:auto;margin-right:auto}}\
.tem-plan{background:#fff;border:1px solid #E8E8E8;border-radius:14px;padding:24px 22px;border-left:5px solid;display:flex;flex-direction:column;position:relative}\
.tem-plan.tem-popular{background:#F6F6F4;transform:scale(1.02)}\
.tem-plan.tem-popular::before{content:"Le plus choisi";position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:#1D8348;color:#fff;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;padding:4px 12px;border-radius:999px;white-space:nowrap}\
.tem-label{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-bottom:14px;align-self:flex-start}\
.tem-dot{width:6px;height:6px;border-radius:50%;background:currentColor}\
.tem-price{font-size:42px;font-weight:600;letter-spacing:-.045em;line-height:1;margin-bottom:2px}\
.tem-period{font-size:13px;color:#9A9A9A;margin-left:4px}\
.tem-billing{font-size:12px;color:#9A9A9A;margin-bottom:18px;min-height:14px}\
.tem-cta{display:block;width:100%;padding:12px 18px;background:#0A0A0A;color:#fff;border:1px solid #0A0A0A;border-radius:9px;font-family:inherit;font-size:13px;font-weight:600;text-decoration:none;text-align:center;cursor:pointer;margin-top:auto;transition:background .15s}\
.tem-cta:hover{background:#2A2A2A}\
.tem-foot{display:flex;justify-content:center;gap:18px;font-size:12.5px;color:#6E6E73}\
.tem-foot a,.tem-foot button{color:#6E6E73;background:none;border:none;text-decoration:underline;text-underline-offset:2px;cursor:pointer;font-family:inherit;font-size:inherit;padding:0}\
.tem-foot a:hover,.tem-foot button:hover{color:#0A0A0A}\
@media (max-width:480px){.tem-foot{flex-direction:column;gap:10px;text-align:center}}\
#tem-banner{position:fixed;top:0;left:0;right:0;z-index:99998;background:#FFF7E6;border-bottom:2px solid #F59E0B;font-family:Geist,-apple-system,sans-serif;color:#1D1D1F}\
.tem-banner-inner{max-width:1200px;margin:0 auto;padding:11px 22px;display:flex;align-items:center;justify-content:space-between;gap:18px;font-size:13.5px;line-height:1.45}\
.tem-banner-msg strong{font-weight:700}\
.tem-banner-msg .tem-banner-sep{margin:0 8px;color:#9A6500}\
.tem-banner-actions{display:flex;align-items:center;gap:14px;flex-shrink:0}\
.tem-banner-actions a{color:#1D1D1F;text-decoration:underline;text-underline-offset:2px;font-size:13px;font-weight:500}\
.tem-banner-actions a.tem-banner-cta{background:#1D1D1F;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px;font-weight:600}\
.tem-banner-actions a.tem-banner-cta:hover{background:#2A2A2A}\
@media (max-width:760px){.tem-banner-inner{flex-direction:column;align-items:flex-start;gap:10px;padding:12px 16px}.tem-banner-actions{width:100%;flex-wrap:wrap}}\
#tem-mut-toast{position:fixed;bottom:24px;right:24px;background:#FFF;border:1px solid #E8E8ED;border-left:4px solid #F59E0B;border-radius:12px;padding:14px 38px 14px 18px;font-family:Geist,-apple-system,sans-serif;color:#1D1D1F;box-shadow:0 12px 32px rgba(0,0,0,.12);z-index:100001;max-width:380px;transform:translateY(120%);transition:transform .22s ease}\
#tem-mut-toast.show{transform:translateY(0)}\
.tem-mut-title{display:block;font-size:13px;font-weight:700;margin-bottom:4px}\
.tem-mut-text{display:block;font-size:13px;line-height:1.5;color:#3A3A3C}\
#tem-mut-close{position:absolute;top:8px;right:10px;background:none;border:none;color:#6E6E73;font-size:18px;line-height:1;cursor:pointer;font-family:inherit;padding:4px;border-radius:4px}\
#tem-mut-close:hover{color:#1D1D1F;background:#F5F5F7}\
@media (max-width:480px){#tem-mut-toast{left:16px;right:16px;bottom:16px;max-width:none}}\
'
    document.head.appendChild(s)
  }

  function buildPlanCard(p) {
    var isPopular = (p.key === preferredPlan)
    var price = billingCycle === 'annual' ? p.annual : p.monthly
    var billing = billingCycle === 'annual'
      ? 'Soit ' + p.annualTotal + ' € facturés en une fois, sans engagement'
      : 'Sans engagement'
    return ''
      + '<article class="tem-plan' + (isPopular ? ' tem-popular' : '') + '" style="border-left-color:' + p.color + '">'
      +   '<span class="tem-label" style="background:' + p.soft + ';color:' + p.color + '">'
      +     '<span class="tem-dot"></span>' + p.name
      +   '</span>'
      +   '<div><span class="tem-price" style="color:' + (p.key === 'croisiere' ? '#0A0A0A' : p.color) + '">' + price + ' €</span><span class="tem-period">/mois</span></div>'
      +   '<div class="tem-billing">' + billing + '</div>'
      +   '<a class="tem-cta" href="/api/stripe/quick-checkout?plan=' + p.key + '&cycle=' + billingCycle + '">Choisir ' + p.name + '</a>'
      + '</article>'
  }

  function rebuildGrid() {
    var grid = document.getElementById('tem-grid')
    if (!grid) return
    grid.innerHTML = PLANS.map(buildPlanCard).join('')
  }

  // Wordings du modal bloquant par état. trial_expired = wording historique
  // préservé tel quel (zéro régression pré-H5b). grace_expired = nouveau,
  // valide pour D4 (popup bloquant non fermable). Tout autre état tombe
  // sur le fallback trial_expired (défensif, ne devrait jamais arriver
  // car buildOverlay n'est appelé que depuis show(state) avec state ∈
  // {trial_expired, grace_expired}).
  function getOverlayContent(state) {
    if (state === 'grace_expired') {
      return {
        h1: 'L’accès à votre compte est clôturé',
        sub: 'Pour retrouver votre espace MovUP, choisissez votre abonnement.'
      }
    }
    return {
      h1: 'Votre essai gratuit est terminé',
      sub: 'Choisissez votre abonnement pour continuer à utiliser MovUP.'
    }
  }

  function buildOverlay(state) {
    if (document.getElementById(OVERLAY_ID)) return
    injectStyles()
    var content = getOverlayContent(state)
    var div = document.createElement('div')
    div.id = OVERLAY_ID
    div.setAttribute('role', 'dialog')
    div.setAttribute('aria-modal', 'true')
    div.setAttribute('aria-labelledby', 'tem-h1')
    div.innerHTML = ''
      + '<div class="tem-card">'
      +   '<h1 class="tem-h1" id="tem-h1">' + content.h1 + '</h1>'
      +   '<p class="tem-sub">' + content.sub + '</p>'
      +   '<div class="tem-toggle-wrap"><div class="tem-toggle" role="group">'
      +     '<button type="button" class="tem-tbtn active" data-billing="monthly">Mensuel</button>'
      +     '<button type="button" class="tem-tbtn" data-billing="annual">Annuel<span class="tem-disc">−15 %</span></button>'
      +   '</div></div>'
      +   '<div class="tem-grid" id="tem-grid"></div>'
      +   '<div class="tem-foot">'
      +     '<a href="/account/privacy">Télécharger mes données</a>'
      +     '<button type="button" id="tem-logout">Se déconnecter</button>'
      +   '</div>'
      + '</div>'
    document.body.appendChild(div)
    rebuildGrid()

    // Toggle handler
    div.querySelectorAll('.tem-tbtn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        billingCycle = btn.getAttribute('data-billing')
        div.querySelectorAll('.tem-tbtn').forEach(function (b) { b.classList.remove('active') })
        btn.classList.add('active')
        rebuildGrid()
      })
    })

    // Logout handler
    var logoutBtn = div.querySelector('#tem-logout')
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
          .finally(function () { window.location.href = '/' })
      })
    }

    // Bloque scroll body
    document.body.style.overflow = 'hidden'

    // Bloque échap (juste pour info — l'overlay couvre déjà tout)
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') e.preventDefault()
    }, { capture: true })
  }

  function show(state) {
    var run = function () { buildOverlay(state) }
    if (document.body) run()
    else document.addEventListener('DOMContentLoaded', run, { once: true })
  }

  // ── Bandeau β (D2 H5b) — grace_active non-bloquant ─────────────────────
  // Persistant en haut de page, l'utilisateur continue à consulter en
  // lecture seule. Aucune durée d'export chiffrée (la rétention vit
  // uniquement dans les CGV, décision 9.16). CTA réabonnement utilise
  // preferredPlan (calque buildPlanCard).
  function buildBanner() {
    if (document.getElementById(BANNER_ID)) return
    injectStyles()
    var upgradeUrl = '/api/stripe/quick-checkout?plan=' + encodeURIComponent(preferredPlan) + '&cycle=monthly'
    var div = document.createElement('div')
    div.id = BANNER_ID
    div.setAttribute('role', 'status')
    div.innerHTML = ''
      + '<div class="tem-banner-inner">'
      +   '<span class="tem-banner-msg">'
      +     '<strong>Votre abonnement a pris fin</strong>'
      +     '<span class="tem-banner-sep">·</span>'
      +     'votre compte est en lecture seule'
      +   '</span>'
      +   '<span class="tem-banner-actions">'
      +     '<a href="/account/privacy">Télécharger mes données</a>'
      +     '<a class="tem-banner-cta" href="' + upgradeUrl + '">Reprendre un abonnement</a>'
      +   '</span>'
      + '</div>'
    document.body.insertBefore(div, document.body.firstChild)
  }

  function showBanner() {
    if (document.body) buildBanner()
    else document.addEventListener('DOMContentLoaded', buildBanner, { once: true })
  }

  // ── Toast mutation bloquée (D3 H5b) — grace_active sur 402 ─────────────
  // Petit, fermable, auto-dismiss 6s (calque pattern auth-401 toast).
  // Re-affiché à chaque mutation tentée (remove + ré-ajout pour reset du
  // timer). Pas de cards plans : c'est un signal d'échec, pas un mur.
  function buildMutToast() {
    injectStyles()
    var existing = document.getElementById(MUT_TOAST_ID)
    if (existing) existing.remove()
    var upgradeUrl = '/api/stripe/quick-checkout?plan=' + encodeURIComponent(preferredPlan) + '&cycle=monthly'
    var t = document.createElement('div')
    t.id = MUT_TOAST_ID
    t.setAttribute('role', 'alertdialog')
    t.innerHTML = ''
      + '<span class="tem-mut-title">Action impossible</span>'
      + '<span class="tem-mut-text">Votre compte MovUP est en lecture seule. <a href="' + upgradeUrl + '" style="color:#1D1D1F;text-decoration:underline;text-underline-offset:2px;font-weight:600">Reprenez un abonnement</a> pour réactiver l’écriture.</span>'
      + '<button type="button" id="tem-mut-close" aria-label="Fermer">×</button>'
    document.body.appendChild(t)
    void t.offsetWidth
    t.classList.add('show')
    var dismiss = function () { try { t.remove() } catch (e) {} }
    var btn = t.querySelector('#tem-mut-close')
    if (btn) btn.addEventListener('click', dismiss)
    setTimeout(dismiss, 6000)
  }

  function showMutationBlocked() {
    if (document.body) buildMutToast()
    else document.addEventListener('DOMContentLoaded', buildMutToast, { once: true })
  }

  // ── Bootcheck (H5b) — discrimine sur data.app_state, source unique H5a ─
  function checkStatus() {
    fetch('/api/user/me', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) return null
        return r.json()
      })
      .then(function (data) {
        if (!data || !data.app_state) return
        if (data.app_state === 'trial_expired' || data.app_state === 'grace_expired') {
          show(data.app_state)
        } else if (data.app_state === 'grace_active') {
          showBanner()
        }
        // 'active' et 'trial_active' : aucune UI.
      })
      .catch(function () { /* silencieux : pas de réseau, pas d'UI */ })
  }

  // ── Intercepteur fetch (H5b) — discrimine sur body.error ───────────────
  // Patche window.fetch en PREMIER (auth-401-handler.js capturera ensuite
  // le fetch déjà patché — chaînage propre via captures successives).
  if (typeof window.fetch === 'function' && !window.__TEM_FETCH_PATCHED) {
    var originalFetch = window.fetch.bind(window)
    window.fetch = function () {
      return originalFetch.apply(null, arguments).then(function (response) {
        if (response && response.status === 402) {
          response.clone().json().then(function (body) {
            if (!body || !body.error) return
            if (body.error === 'trial_expired' || body.error === 'grace_expired') {
              show(body.error)
            } else if (body.error === 'grace_active') {
              showMutationBlocked()
            }
          }).catch(function () { /* ignore */ })
        }
        return response
      })
    }
    window.__TEM_FETCH_PATCHED = true
  }

  // Init dès que le DOM est prêt
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkStatus, { once: true })
  } else {
    checkStatus()
  }
})()
