// public/js/sector-autocomplete.js
// Composant autocomplete secteur NAF — réutilisable.
// Source de vérité : un <select> HTML caché qui contient le catalogue NAF
// (optgroup + option). On en construit un index fuzzy interne, puis on
// branche un input + un dropdown personnalisé dessus.
//
// Pattern porté à l'identique de public/leads.html (synonymes, scoring,
// rendu, navigation clavier). À terme leads.html pourra l'importer aussi.
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

  var SYNONYMS = {
    'opticien':['4778A','8690F'],'optique':['4778A','3250B'],'lunettes':['4778A'],
    'coiffeur':['9602A'],'coiffure':['9602A'],'esthetique':['9602B'],'esthétique':['9602B'],
    'esthéticienne':['9602B'],'spa':['9604Z'],'beaute':['9602B','9604Z'],'beauté':['9602B','9604Z'],
    'boulanger':['1071C'],'boulangerie':['1071A','1071C'],'patisserie':['1071D','1072Z'],'pâtisserie':['1071D','1072Z'],
    'boucher':['4722Z','1013B'],'boucherie':['4722Z'],'fleuriste':['4776Z'],
    'pharmacie':['4773Z'],'pharmacien':['4773Z'],'dentiste':['8623Z'],
    'medecin':['8621Z'],'médecin':['8621Z'],'generaliste':['8621Z'],'chirurgien':['8622B'],
    'kine':['8690E'],'kiné':['8690E'],'infirmier':['8690D'],'veterinaire':['7500Z'],'vétérinaire':['7500Z'],
    'taxi':['4932Z'],'vtc':['4932Z'],'demenagement':['4942Z'],'déménagement':['4942Z'],
    'plombier':['4322A'],'electricien':['4321A'],'électricien':['4321A'],
    'menuisier':['4332A'],'peintre':['4334Z'],'macon':['4399C'],'maçon':['4399C'],
    'couvreur':['4391A'],'charpentier':['4391A'],'architecte':['7111Z'],'geometre':['7112A'],
    'avocat':['6910Z'],'notaire':['6910Z'],'comptable':['6920Z'],'expert-comptable':['6920Z'],
    'agence immobiliere':['6831Z'],'agence immobilière':['6831Z'],
    'agence evenementielle':['8230Z'],'agence événementielle':['8230Z'],
    'evenementiel':['8230Z'],'événementiel':['8230Z'],'traiteur':['5621Z'],
    'restaurant':['5610A','5610B'],'cafe':['5630Z'],'café':['5630Z'],'bar':['5630Z'],
    'hotel':['5510Z'],'hôtel':['5510Z'],'supermarche':['4711A'],'épicerie':['4711D'],
    'librairie':['4761Z'],'auto-ecole':['8553Z'],'auto-école':['8553Z'],
    'formation':['8559A','8559B'],'informatique':['6201Z','6202A'],'developpeur':['6201Z'],'développeur':['6201Z'],
    'webdesign':['7410Z'],'designer':['7410Z'],'photographe':['7420Z'],
    'publicite':['7311Z'],'publicité':['7311Z'],'marketing':['7311Z'],
    'recrutement':['7810Z'],'securite':['8010Z'],'sécurité':['8010Z'],
    'nettoyage':['8121Z','8122Z'],'jardinage':['8130Z'],'paysagiste':['8130Z'],
    'transport':['4941A','4941B'],'imprimerie':['1812Z'],
    'bijouterie':['4777Z'],'horlogerie':['4777Z'],'garage':['4520A'],'garagiste':['4520A'],
    'carrosserie':['4520B'],'concessionnaire':['4511Z'],
    'salle de sport':['9313Z'],'fitness':['9313Z'],'gym':['9313Z'],
    'clinique':['8610Z'],'hopital':['8610Z'],'hôpital':['8610Z'],
    'osteopathe':['8690A'],'ostéopathe':['8690A'],
    'psychologue':['8690F'],'sophrologue':['8690F'],
    'naturopathe':['8690F'],'dieteticien':['8690F'],
    'podologue':['8690A'],'audioprothesiste':['4778A'],
    'ehpad':['8710A'],'maison de retraite':['8710A'],
    'musculation':['9313Z'],
    'crossfit':['9313Z'],'yoga':['9313Z'],'pilates':['9313Z'],
    'natation':['9311Z'],'piscine':['9311Z'],
    'tennis':['9312Z'],'golf':['9312Z'],
    'karting':['9329Z'],'bowling':['9329Z'],
    'escape game':['9329Z'],'trampoline':['9329Z'],
    'vigneron':['0121Z'],'viticulteur':['0121Z'],
    'apiculteur':['0149Z'],'maraicher':['0113Z'],
    'pecheur':['0311Z'],'pêcheur':['0311Z'],
    'ostreiculteur':['0321Z'],'huitres':['0321Z'],
    'moules':['0321Z'],'conchyliculture':['0321Z'],
    'ambulance':['8690J'],'ambulancier':['8690J'],
    'panneaux solaires':['4321A'],'solaire':['4321A'],
    'pompe a chaleur':['4322B'],'recyclage':['3832Z'],
    'tatouage':['9609Z'],'chocolatier':['1082Z'],
    'brasserie':['1105Z'],'distillerie':['1101Z'],
    'casino':['9200Z'],'musee':['9102Z'],'musée':['9102Z'],
    'theatre':['9001Z'],'théâtre':['9001Z'],
    'cinema':['5914Z'],'cinéma':['5914Z'],
    'association':['9499Z'],'pressing':['9601A'],
    'cordonnier':['9523Z'],'pompes funebres':['9603Z'],
    'agence voyage':['7911Z'],'camping':['5530Z'],
    'gite':['5520Z'],'gîte':['5520Z'],
    'startup':['6201Z'],'ecommerce':['4791A'],
    'drone':['3030Z'],'tattoo':['9609Z'],
    'micro creche':['8891A'],'halte garderie':['8891A'],
    'centre equestre':['9319Z'],'equitation':['9319Z'],
    'cardiologue':['8622A'],
    'dermatologue':['8622A'],'gynecologue':['8622A'],
    'pediatre':['8622A'],'ophtalmologue':['8622A'],
    'sage-femme':['8690C'],'orthophoniste':['8690D'],
    'ergotherapeute':['8690A'],'acupuncteur':['8690F'],
    'galerie art':['4778B'],'zoo':['9104Z'],
    'mairie':['8411Z'],'auto ecole':['8553Z'],
    'creche':['8891A'],'crèche':['8891A'],'ecole':['8520Z'],'école':['8520Z']
  }

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
