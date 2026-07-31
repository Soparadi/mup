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

  // Moteur de calcul (norm, score, highlight, recherche) : IMPLÉMENTATION UNIQUE
  // partagée /js/sector-search.js (chargé avant ce module, après les appellations).
  // La table d'appellations vit dans /js/sector-appellations.js.
  var _norm = window.SectorSearch.norm

  function _esc(s) {
    if (!s) return ''
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  var _hl = window.SectorSearch.hl

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
      return window.SectorSearch.searchNAF(q, INDEX)
    }

    function fallbackLabelSearch(q) {
      return window.SectorSearch.fallbackLabelSearch(q, INDEX)
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
