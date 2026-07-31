// public/js/sector-autocomplete.js
// Composant autocomplete secteur NAF — réutilisable.
// Source de vérité : un <select> HTML caché qui contient le catalogue NAF
// (optgroup + option). On en construit un index fuzzy interne, puis on
// branche un input + un dropdown personnalisé dessus.
//
// Pattern porté à l'identique de public/prospection.html (synonymes, scoring,
// rendu, navigation clavier). À terme prospection.html pourra l'importer aussi.
//
// API publique :
//   window.SectorAutocomplete.init({
//     sourceSelectId : 'lead-secteur-source',  // <select> caché contenant les <option>
//     inputId        : 'sa-input',             // <input type="text">
//     dropdownId     : 'sa-dropdown',          // <div class="acd"> vide
//     clearBtnId     : 'sa-clear',             // (option) bouton croix
//     placeholder    : 'opticien, traiteur…',  // (option) placeholder input
//     onPick         : function(code, label){...},
//     onClear        : function(){...}
//   })
//   → renvoie { pick(code,label), clear(), value, label }

(function () {
  'use strict'

  // Dictionnaire d'appellations : SOURCE UNIQUE partagee /js/sector-appellations.js
  // (charge avant ce module par la page). La table inline a ete deplacee la-bas.
  var SYNONYMS = (window.SectorAppellations) || {}

  function _norm(s) {
    return String(s).toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ').trim()
  }

  function _esc(s) {
    if (!s) return ''
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function _hl(text, q) {
    var n = _norm(text), qn = _norm(q), i = n.indexOf(qn)
    if (i < 0) return _esc(text)
    return _esc(text.slice(0, i))
      + '<span class="acd-hl">' + _esc(text.slice(i, i + qn.length)) + '</span>'
      + _esc(text.slice(i + qn.length))
  }

  function _score(q, item) {
    var qn = _norm(q), code = item.code.toLowerCase(), lb = item.ln
    if (code === qn || code.replace(/[^a-z0-9]/g, '') === qn.replace(/[^a-z0-9]/g, '')) return 100
    if (code.indexOf(qn) === 0) return 95
    var syns = SYNONYMS[qn] || []
    if (syns.indexOf(item.code) >= 0) return 90
    for (var k in SYNONYMS) {
      if (SYNONYMS[k].indexOf(item.code) >= 0 && k.indexOf(qn) >= 0 && qn.length >= 3) return 75
    }
    var words = lb.split(' ')
    var qw = qn.split(' ').filter(function (w) { return w.length >= 2 })
    if (qw.length > 0 && qw.every(function (w) { return words.some(function (x) { return x.indexOf(w) === 0 }) })) return 80
    if (lb.indexOf(qn) >= 0 && qn.length >= 3) return 70
    var pc = qw.filter(function (w) { return lb.indexOf(w) >= 0 && w.length >= 3 }).length
    if (pc > 0) return 40 + pc * 10
    return 0
  }

  function init(opts) {
    var sourceSelect = document.getElementById(opts.sourceSelectId)
    var input = document.getElementById(opts.inputId)
    var dd = document.getElementById(opts.dropdownId)
    var clr = opts.clearBtnId ? document.getElementById(opts.clearBtnId) : null
    if (!sourceSelect || !input || !dd) {
      console.warn('[SectorAutocomplete] DOM introuvable', opts)
      return null
    }

    if (opts.placeholder) input.setAttribute('placeholder', opts.placeholder)

    // Index construit depuis le <select> caché
    var INDEX = []
    sourceSelect.querySelectorAll('option[value]').forEach(function (o) {
      if (!o.value) return
      var label = o.text.replace(/\s*\([^)]+\)\s*$/, '').trim()
      INDEX.push({ code: o.value, label: label, ln: _norm(label) })
    })

    var current = { code: '', label: '' }
    var acIdx = -1
    var acList = []

    function searchNAF(q) {
      if (!q || q.trim().length < 2) return []
      return INDEX
        .map(function (x) { return Object.assign({}, x, { sc: _score(q, x) }) })
        .filter(function (x) { return x.sc > 0 })
        .sort(function (a, b) { return b.sc - a.sc })
        .slice(0, 12)
    }

    function fallbackLabelSearch(q) {
      var qn = _norm(q)
      var results = []
      INDEX.forEach(function (item) {
        if (item.ln.indexOf(qn) >= 0 && qn.length >= 3) {
          results.push(Object.assign({}, item, { sc: 50 }))
        }
      })
      return results.slice(0, 8)
    }

    function _renderItem(r, q) {
      return '<div class="acd-item" data-code="' + _esc(r.code) + '" data-label="' + _esc(r.label) + '">'
        + '<span class="acd-code">' + _esc(r.code) + '</span>'
        + '<span class="acd-label">' + _hl(r.label, q) + '</span>'
        + '</div>'
    }

    function renderAC(q, results) {
      if (!results.length) {
        dd.innerHTML = '<div class="acd-empty">Aucun résultat pour "' + _esc(q) + '"</div>'
        dd.classList.add('open')
        return
      }
      var hot = results.filter(function (r) { return r.sc >= 80 })
      var other = results.filter(function (r) { return r.sc < 80 })
      var html = ''
      if (hot.length) {
        html += '<div class="acd-sec">Meilleurs résultats</div>'
        hot.forEach(function (r) { html += _renderItem(r, q) })
      }
      if (other.length) {
        html += '<div class="acd-sec">Autres résultats</div>'
        other.forEach(function (r) { html += _renderItem(r, q) })
      }
      dd.innerHTML = html
      dd.classList.add('open')
      acIdx = -1

      // Délégation click sur les items (mousedown pour devancer le blur)
      Array.prototype.forEach.call(dd.querySelectorAll('.acd-item'), function (el) {
        el.addEventListener('mousedown', function (ev) {
          ev.preventDefault()
          pick(el.dataset.code, el.dataset.label)
        })
      })
    }

    function _updFocus(items) {
      Array.prototype.forEach.call(items, function (el, i) {
        el.classList.toggle('focus', i === acIdx)
        if (i === acIdx) el.scrollIntoView({ block: 'nearest' })
      })
    }

    function onSectorInput(v) {
      if (clr) clr.classList.toggle('show', v.length > 0)

      // Toute frappe invalide la sélection précédente (force re-pick)
      if (current.code) {
        current.code = ''
        current.label = ''
        input.classList.remove('locked')
        if (typeof opts.onClear === 'function') opts.onClear()
      }

      if (v.trim().length < 2) { dd.classList.remove('open'); return }
      acList = searchNAF(v)
      if (acList.length === 0 && v.trim().length >= 3) {
        acList = fallbackLabelSearch(v)
      }
      renderAC(v, acList)
    }

    function onSectorFocus() {
      var v = input.value
      if (v.trim().length >= 2) {
        acList = searchNAF(v)
        if (acList.length === 0 && v.trim().length >= 3) acList = fallbackLabelSearch(v)
        renderAC(v, acList)
      }
    }

    function onSectorKey(e) {
      var items = dd.querySelectorAll('.acd-item')
      if (!items.length) return
      if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = Math.min(acIdx + 1, items.length - 1); _updFocus(items) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); acIdx = Math.max(acIdx - 1, 0); _updFocus(items) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        if (acIdx >= 0 && items[acIdx]) pick(items[acIdx].dataset.code, items[acIdx].dataset.label)
      }
      else if (e.key === 'Escape') { dd.classList.remove('open') }
    }

    function pick(code, label) {
      current.code = code
      current.label = label
      input.value = label
      input.classList.add('locked')
      if (clr) clr.classList.add('show')
      dd.classList.remove('open')
      if (typeof opts.onPick === 'function') opts.onPick(code, label)
    }

    function clear() {
      current.code = ''
      current.label = ''
      input.value = ''
      input.classList.remove('locked')
      if (clr) clr.classList.remove('show')
      dd.classList.remove('open')
      if (typeof opts.onClear === 'function') opts.onClear()
    }

    input.addEventListener('input', function () { onSectorInput(input.value) })
    input.addEventListener('focus', onSectorFocus)
    input.addEventListener('keydown', onSectorKey)
    if (clr) clr.addEventListener('click', clear)
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#' + opts.inputId) && !e.target.closest('#' + opts.dropdownId)) {
        dd.classList.remove('open')
      }
    })

    return {
      pick: pick,
      clear: clear,
      get value() { return current.code },
      get label() { return current.label },
      indexSize: function () { return INDEX.length }
    }
  }

  window.SectorAutocomplete = { init: init }
})()
