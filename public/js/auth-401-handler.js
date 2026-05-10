// Handler global session expirée — injecté sur les 15 pages app.
// Comportement :
//   1. Patch window.fetch : toute réponse 401 sur une route /api/* déclenche
//      un toast "Votre session a expiré, reconnectez-vous" puis redirect vers
//      /login?redirect=<page_courante> (préserve le contexte pour reconnexion).
//   2. Idempotence via window.__AUTH_401_PATCHED (cohabite avec __TEM_FETCH_PATCHED
//      du modal trial expiré : 402 reste géré par trial-expired-modal.js).
//   3. Flag window.__AUTH_REDIRECTING__ pour éviter double redirect en cas de
//      polling / requêtes parallèles.
//
// DA : toast noir #1D1D1F, texte blanc, accent rouge --mup-danger #DC2626,
// Geist, slide-in haut-droite, auto-dismiss 4s ou clic.

(function () {
  'use strict'

  if (window.__AUTH_401_PATCHED) return
  window.__AUTH_401_PATCHED = true

  // ── Whitelist des endpoints qui sont vrais indicateurs de session MUP ──
  // Refonte post-incident /leads : avant on déclenchait sur tout 401 d'une URL
  // contenant "/api/", ce qui faisait remonter à tort les 401 propagés par les
  // proxies upstream (INSEE Sirene OAuth expiré, recherche-entreprises rate
  // limit, etc.) comme "session expirée".
  // Désormais, le toast + redirect ne se déclenchent QUE si le 401 vient d'un
  // endpoint MUP qui requiert effectivement une session (CRUD core + auth).
  // Les proxies upstream et endpoints externes leak leurs 401 sans déclencher.
  var TRUSTED_AUTH_PATHS = [
    '/api/pipeline',
    '/api/contacts',
    '/api/agenda',
    '/api/devis',
    '/api/factures',
    '/api/frais',
    '/api/mail',
    '/api/visio',
    '/api/leads',          // store leads custom (à distinguer de /api/sirene)
    '/api/account/',
    '/api/user-plan',
    '/api/auth/me',        // 401 ici = session vraiment expirée
    '/api/auth/forgot-password',
    '/api/auth/reset-password'
    // Exclus volontairement : /api/auth/login (401 = mauvais mdp, pas session expirée),
    //                         /api/auth/logout (401 attendu, idempotent),
    //                         /api/user/me (consommé par trial-expired-modal),
    //                         /api/sirene/*, /api/geocode, /api/search, /api/public/*,
    //                         /api/stripe/*, /api/v2/webhooks/* (proxies / webhooks),
    //                         /api/route, /api/ban/*, /api/nominatim/*.
  ]

  function urlPath(url) {
    var s = String(url)
    try {
      if (s.indexOf('http') === 0) {
        var u = new URL(s)
        s = u.pathname
      }
    } catch (e) { /* ignore */ }
    return s
  }

  function isTrustedAuthEndpoint(url) {
    if (!url) return false
    var s = urlPath(url)
    for (var i = 0; i < TRUSTED_AUTH_PATHS.length; i++) {
      var p = TRUSTED_AUTH_PATHS[i]
      // startsWith(p) avec terminator strict pour éviter /api/leadsXXX
      if (s.indexOf(p) === 0) {
        var c = s.charAt(p.length)
        if (c === '' || c === '/' || c === '?' || c === '&') return true
      }
    }
    return false
  }

  function injectToastStyles() {
    if (document.getElementById('mup-401-toast-style')) return
    var s = document.createElement('style')
    s.id = 'mup-401-toast-style'
    s.textContent = '\
#mup-401-toast{position:fixed;top:18px;right:18px;background:#1D1D1F;color:#fff;\
border-radius:10px;padding:14px 18px;font-family:Geist,-apple-system,sans-serif;\
font-size:13px;font-weight:500;line-height:1.4;display:flex;align-items:center;gap:11px;\
box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:100000;max-width:340px;cursor:pointer;\
transform:translateX(120%);transition:transform .22s ease}\
#mup-401-toast.show{transform:translateX(0)}\
#mup-401-toast .mup-401-dot{width:8px;height:8px;border-radius:50%;background:#DC2626;flex-shrink:0}\
'
    document.head.appendChild(s)
  }

  function showToast(message) {
    if (!document.body) return
    injectToastStyles()
    var existing = document.getElementById('mup-401-toast')
    if (existing) existing.remove()
    var t = document.createElement('div')
    t.id = 'mup-401-toast'
    t.setAttribute('role', 'status')
    t.innerHTML = '<span class="mup-401-dot" aria-hidden="true"></span><span>' + message + '</span>'
    document.body.appendChild(t)
    // Force reflow puis slide-in
    void t.offsetWidth
    t.classList.add('show')
    var dismiss = function () { try { t.remove() } catch (e) {} }
    t.addEventListener('click', dismiss)
    setTimeout(dismiss, 4000)
  }

  function buildRedirectUrl() {
    var here = window.location.pathname + (window.location.search || '')
    if (!here || here === '/login') return '/login'
    return '/login?redirect=' + encodeURIComponent(here)
  }

  function triggerSessionExpired() {
    if (window.__AUTH_REDIRECTING__) return
    window.__AUTH_REDIRECTING__ = true
    showToast('Votre session a expiré, reconnectez-vous')
    var dest = buildRedirectUrl()
    // Léger délai pour laisser le toast apparaître avant la redirection
    setTimeout(function () {
      window.location.href = dest
    }, 700)
  }

  // Chaînage avec d'éventuels patches existants (trial-expired-modal.js etc.)
  var originalFetch = window.fetch.bind(window)
  window.fetch = function () {
    var args = arguments
    var url = (args[0] && typeof args[0] === 'object' && args[0].url) ? args[0].url : args[0]
    return originalFetch.apply(null, args).then(function (response) {
      if (response && response.status === 401 && url) {
        if (isTrustedAuthEndpoint(url)) {
          triggerSessionExpired()
        } else {
          // 401 sur endpoint non-trusted (proxy upstream qui leak, etc.) →
          // ne PAS déclencher le toast. Logger pour debug.
          try { console.warn('[auth-401] ignored 401 on non-trusted endpoint:', urlPath(url)) } catch (e) {}
        }
      }
      return response
    })
  }
})()
