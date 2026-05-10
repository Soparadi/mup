/* ─────────────────────────────────────────────────────────────────
   MUPCard — composant fiche unifiée (sprint fiche unifiée).
   Format minimaliste : badge secteur + nom dirigeant + raison sociale
   + adresse 1 ligne + bouton "Ajouter aux contacts" (état lead) ou
   mention "Déjà dans Pipeline" (état engaged).
   Doctrine 8 avril : MÊME conteneur, contenu adapté à l'état.
   Phase 1 : /leads (cards panneau + popup Leaflet). /pipeline en
   sprint séparé pour préserver drag&drop + openDetail.
   ───────────────────────────────────────────────────────────────── */
(function () {
  if (window.MUPCard) return;

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _injectStyles() {
    if (document.getElementById('mup-card-styles')) return;
    var s = document.createElement('style');
    s.id = 'mup-card-styles';
    s.textContent = ''
      + '.mup-card{background:var(--card);border:1px solid var(--border);border-radius:12px;'
      + 'padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.04);'
      + 'display:flex;flex-direction:column;gap:8px;font-family:var(--font);'
      + 'transition:border-color .12s,box-shadow .15s}'
      + '.mup-card:hover{border-color:var(--border2,#C7C7CC);box-shadow:0 2px 12px rgba(0,0,0,.06)}'
      + '.mup-card-tag{align-self:flex-start;background:var(--surface2,#EBEBF0);color:var(--muted);'
      + 'font-size:10px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;'
      + 'padding:4px 8px;border-radius:4px;line-height:1.2}'
      + '.mup-card-title{font-size:14px;font-weight:700;color:var(--text);'
      + 'text-transform:uppercase;letter-spacing:.3px;line-height:1.2;word-break:break-word}'
      + '.mup-card-subtitle{font-size:12px;color:var(--muted);text-transform:uppercase;'
      + 'letter-spacing:.3px;line-height:1.3;word-break:break-word}'
      + '.mup-card-addr{font-size:12px;color:var(--muted);line-height:1.4;word-break:break-word}'
      + '.mup-card-cta{margin-top:4px;padding:10px 14px;background:var(--text);color:#fff;'
      + 'border:0;border-radius:8px;font-family:var(--font);font-size:13px;font-weight:600;'
      + 'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;'
      + 'transition:background .15s;width:100%}'
      + '.mup-card-cta:hover:not(:disabled){background:#000}'
      + '.mup-card-cta:disabled{background:var(--surface2,#EBEBF0);color:var(--muted);cursor:default}'
      + '.mup-card[data-state="engaged"] .mup-card-cta{background:var(--surface2,#EBEBF0);'
      + 'color:var(--muted);cursor:default}'
      // Variante popup Leaflet : padding/sizing adapté à maxWidth 280px
      + '.mup-card.mup-card-popup{box-shadow:none;border:none;padding:12px 14px}'
      + '.leaflet-popup-content .mup-card{margin:0}';
    document.head.appendChild(s);
  }

  // SVG plus stroke (charte : pas d'emoji, stroke uniquement)
  var SVG_PLUS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  // Capitalise un nom propre (gère tirets, apostrophes)
  function _toTitle(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, function (_, sep, ch) {
      return sep + ch.toUpperCase();
    });
  }

  // data : { siret, title, subtitle, nafLabel, address, state, onAdd, popup }
  // state : 'lead' (default) | 'engaged'
  // popup : true → variante compact pour Leaflet popup
  function render(data, opts) {
    if (!data) data = {};
    opts = opts || {};
    var state = opts.state || data.state || 'lead';
    var asPopup = !!opts.popup;

    _injectStyles();

    var classes = ['mup-card'];
    if (asPopup) classes.push('mup-card-popup');

    var attrs = 'class="' + classes.join(' ') + '" data-state="' + state + '"';
    if (data.siret) attrs += ' data-siret="' + _esc(data.siret) + '"';
    if (data.id) attrs += ' data-id="' + _esc(data.id) + '"';

    var html = '<div ' + attrs + '>';

    if (data.nafLabel) {
      html += '<div class="mup-card-tag">' + _esc(String(data.nafLabel).toUpperCase()) + '</div>';
    }

    var title = data.title || data.name || '';
    if (title) {
      html += '<div class="mup-card-title">' + _esc(String(title).toUpperCase()) + '</div>';
    }

    var sub = data.subtitle || '';
    if (sub && sub.toLowerCase() !== String(title).toLowerCase()) {
      html += '<div class="mup-card-subtitle">' + _esc(String(sub).toUpperCase()) + '</div>';
    }

    if (data.address) {
      html += '<div class="mup-card-addr">' + _esc(data.address) + '</div>';
    }

    if (state === 'lead') {
      var onAdd = data.onAdd || (data.id ? "addToPipeline('" + _esc(data.id) + "')" : '');
      var disabledAttr = onAdd ? '' : ' disabled';
      html += '<button type="button" class="mup-card-cta"' + (onAdd ? ' onclick="' + onAdd + '"' : '') + disabledAttr + '>'
        + SVG_PLUS + 'Ajouter aux contacts</button>';
    } else if (state === 'engaged') {
      html += '<button type="button" class="mup-card-cta" disabled>Déjà dans le pipeline</button>';
    }

    html += '</div>';
    return html;
  }

  window.MUPCard = {
    render: render,
    toTitleCase: _toTitle
  };
})();
