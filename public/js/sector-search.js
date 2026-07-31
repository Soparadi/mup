// public/js/sector-search.js
// Moteur de recherche floue secteur NAF — IMPLÉMENTATION UNIQUE partagée.
// Fonctions de calcul extraites telles quelles de public/prospection.html
// (référence). Chargé par prospection.html ET par la vitrine (index.html, via
// sector-autocomplete.js), APRÈS sector-appellations.js dont il lit la table.
// DÉPLACEMENT, PAS RÉVISION — aucun score, seuil, garde de longueur ni
// troncature modifié. L'index NAF est passé en paramètre à searchNAF /
// fallbackLabelSearch : il reste construit par chaque page (source propre).
(function () {
  'use strict'

  var SYNONYMS = window.SectorAppellations || {}

  function _norm(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  }
  function _esc(s) {
    if(!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  // Variantes pluriel/singulier basique : ajoute la version inverse du 's' final.
  function _wordVariants(w) {
    var v = [w];
    if (w.length > 4 && w.charAt(w.length-1) === 's') v.push(w.slice(0, -1));
    if (w.length > 3 && w.charAt(w.length-1) !== 's') v.push(w + 's');
    return v;
  }
  // Match tolérant : le mot requête préfixe un mot de libellé (jamais l'inverse,
  // sinon « c » de clinique matcherait « c » de n.c.a.), mots de libellé < 2 chars
  // ignorés, + variantes plural + préfixe commun ≥ 5 chars (radical métier :
  // platrier↔platrerie, coiffeur↔coiffure).
  function _wordsMatch(qWord, lWord) {
    var qV = _wordVariants(qWord), lV = _wordVariants(lWord);
    for (var i = 0; i < qV.length; i++) {
      for (var j = 0; j < lV.length; j++) {
        if (lV[j].length < 2) continue;
        if (lV[j].startsWith(qV[i])) return true;
      }
    }
    if (qWord.length >= 5 && lWord.length >= 5 && qWord.slice(0,5) === lWord.slice(0,5)) return true;
    return false;
  }
  function _score(q, item) {
    var qn=_norm(q), code=item.code.toLowerCase(), lb=item.ln;
    if(code===qn || code.replace(/[^a-z0-9]/g,'')=== qn.replace(/[^a-z0-9]/g,'')) return 100;
    if(code.startsWith(qn)) return 95;
    var syns=SYNONYMS[qn]||[];
    if(syns.indexOf(item.code)>=0) return 90;
    for(var k in SYNONYMS){ if(SYNONYMS[k].indexOf(item.code)>=0 && k.indexOf(qn)>=0 && qn.length>=3) return 75; }
    var words=lb.split(' '), qw=qn.split(' ').filter(function(w){return w.length>=2;});
    if(qw.length>0 && qw.every(function(w){return words.some(function(x){return _wordsMatch(w, x);});})) return 80;
    if(lb.indexOf(qn)>=0 && qn.length>=3) return 70;
    var pc=qw.filter(function(w){return words.some(function(x){return _wordsMatch(w,x);})&&w.length>=3;}).length;
    if(pc>0) return 40+pc*10;
    return 0;
  }
  function _hl(text, q) {
    var n=_norm(text), qn=_norm(q), i=n.indexOf(qn);
    if(i<0) return _esc(text);
    return _esc(text.slice(0,i))+'<span class="acd-hl">'+_esc(text.slice(i,i+qn.length))+'</span>'+_esc(text.slice(i+qn.length));
  }
  function searchNAF(q, index) {
    if(!q||q.trim().length<2) return [];
    return index
      .map(function(x){ return Object.assign({},x,{sc:_score(q,x)}); })
      .filter(function(x){ return x.sc>0; })
      .sort(function(a,b){ return b.sc-a.sc; })
      .slice(0,12);
  }
  function fallbackLabelSearch(q, index) {
    var qn = _norm(q);
    var results = [];
    index.forEach(function(item) {
      if (item.ln.includes(qn) && qn.length >= 3) {
        results.push(Object.assign({}, item, {sc: 50}));
      }
    });
    return results.slice(0, 8);
  }

  window.SectorSearch = {
    norm: _norm,
    wordVariants: _wordVariants,
    wordsMatch: _wordsMatch,
    score: _score,
    hl: _hl,
    searchNAF: searchNAF,
    fallbackLabelSearch: fallbackLabelSearch
  }
})()
