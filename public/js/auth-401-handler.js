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

  // Routes API exclues du redirect 401 (logout idempotent : 401 attendu si
  // session déjà invalide → on ne redirige pas en boucle).
  var EXCLUDED_PATHS = ['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/user/me']

  function isExcludedUrl(url) {
    if (!url) return false
    var s = String(url)
    // Normalise URLs absolues vers path relatif
    try {
      if (s.indexOf('http') === 0) {
        var u = new URL(s)
        s = u.pathname
      }
    } catch (e) { /* ignore */ }
    for (var i = 0; i < EXCLUDED_PATHS.length; i++) {
      if (s.indexOf(EXCLUDED_PATHS[i]) === 0) return true
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
        var s = String(url)
        if (s.indexOf('/api/') !== -1 && !isExcludedUrl(url)) {
          triggerSessionExpired()
        }
      }
      return response
    })
  }
})()
