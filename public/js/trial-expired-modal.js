// Popup bloquant essai expiré — injecté sur toutes les pages app.
// Comportement :
//   1. Au load, fetch GET /api/user/me. Si trial_status === 'expired', affiche
//      l'overlay full-screen non fermable.
//   2. Intercepte toutes les réponses fetch : si 402 trial_expired, affiche
//      également l'overlay (couvre le cas où l'essai expire pendant la session).
//
// Style : reprend les codes visuels de .movup-pricing (couleurs métiers,
// pastilles, prix colorés) avec préfixe .tem- pour éviter toute collision
// avec les CSS des pages app.
//
// Auteur : passe trial 14j (commit à venir)

(function () {
  'use strict'

  // Évite double init si le script est chargé plusieurs fois
  if (window.__TEM_INITED) return
  window.__TEM_INITED = true

  var PLANS = [
    { key: 'demarrage', name: 'Démarrage', monthly: 19, annual: 16, color: '#0BBCD4', soft: 'rgba(11,188,212,.12)' },
    { key: 'activite',  name: 'Activité',  monthly: 29, annual: 25, color: '#1D8348', soft: 'rgba(29,131,72,.12)' },
    { key: 'croisiere', name: 'Croisière', monthly: 39, annual: 33, color: '#1D8348', soft: 'rgba(29,131,72,.12)' }
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
'
    document.head.appendChild(s)
  }

  function buildPlanCard(p) {
    var isPopular = (p.key === preferredPlan)
    var price = billingCycle === 'annual' ? p.annual : p.monthly
    var billing = billingCycle === 'annual'
      ? 'Soit ' + (p.annual * 12) + ' € par an'
      : 'Sans engagement'
    return ''
      + '<article class="tem-plan' + (isPopular ? ' tem-popular' : '') + '" style="border-left-color:' + p.color + '">'
      +   '<span class="tem-label" style="background:' + p.soft + ';color:' + p.color + '">'
      +     '<span class="tem-dot"></span>' + p.name
      +   '</span>'
      +   '<div><span class="tem-price" style="color:' + (p.key === 'croisiere' ? '#0A0A0A' : p.color) + '">' + price + ' €</span><span class="tem-period">/mois</span></div>'
      +   '<div class="tem-billing">' + billing + '</div>'
      +   '<a class="tem-cta" href="/account/upgrade?plan=' + p.key + '&cycle=' + billingCycle + '">Choisir ' + p.name + '</a>'
      + '</article>'
  }

  function rebuildGrid() {
    var grid = document.getElementById('tem-grid')
    if (!grid) return
    grid.innerHTML = PLANS.map(buildPlanCard).join('')
  }

  function buildOverlay() {
    if (document.getElementById(OVERLAY_ID)) return
    injectStyles()
    var div = document.createElement('div')
    div.id = OVERLAY_ID
    div.setAttribute('role', 'dialog')
    div.setAttribute('aria-modal', 'true')
    div.setAttribute('aria-labelledby', 'tem-h1')
    div.innerHTML = ''
      + '<div class="tem-card">'
      +   '<h1 class="tem-h1" id="tem-h1">Votre essai gratuit est terminé</h1>'
      +   '<p class="tem-sub">Choisissez votre abonnement pour continuer à utiliser MovUP.</p>'
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

  function show() {
    if (document.body) buildOverlay()
    else document.addEventListener('DOMContentLoaded', buildOverlay, { once: true })
  }

  // Check au load
  function checkStatus() {
    fetch('/api/user/me', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) return null
        return r.json()
      })
      .then(function (data) {
        if (data && data.trial_status === 'expired') show()
      })
      .catch(function () { /* silencieux : pas de réseau, pas de popup */ })
  }

  // Intercepteur fetch global : toute réponse 402 trial_expired déclenche le popup
  if (typeof window.fetch === 'function' && !window.__TEM_FETCH_PATCHED) {
    var originalFetch = window.fetch.bind(window)
    window.fetch = function () {
      return originalFetch.apply(null, arguments).then(function (response) {
        if (response && response.status === 402) {
          response.clone().json().then(function (body) {
            if (body && body.error === 'trial_expired') show()
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
