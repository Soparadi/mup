// Helpers société — purs, sans dépendance ni I/O.
// Réutilisables par les routes /api/societes ET le futur moteur d'import
// (le rapprochement d'un import se fera sur cle_normalisee).

// Suffixes juridiques + ville retirés en FIN de raison sociale pour le
// rapprochement. L'ordre n'importe pas : retrait répété tant qu'un suffixe
// final matche (gère "X SARL Paris" -> "x").
const SUFFIXES_FIN = ['sarl', 'sasu', 'eurl', 'sas', 'sci', 'sa', 'sl', 'paris']

// raison sociale -> clé normalisée stable pour dédoublonnage / rapprochement.
//   minuscules · accents retirés (NFD) · ponctuation -> espace ·
//   suffixes/ville en fin retirés · espaces compressés · trim
//   "BETC Paris"        -> "betc"
//   "Studio Riou SARL"  -> "studio riou"
export function normaliserSociete(raison) {
  if (!raison || typeof raison !== 'string') return ''
  let s = raison
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')    // ponctuation -> espace
    .replace(/\s+/g, ' ')
    .trim()
  let changed = true
  while (changed && s) {
    changed = false
    for (const suf of SUFFIXES_FIN) {
      if (s === suf) { s = ''; changed = true; break }
      if (s.endsWith(' ' + suf)) {
        s = s.slice(0, -(suf.length + 1)).trim()
        changed = true
        break
      }
    }
  }
  return s
}

// ── PARENTHÈSES D'UNE RAISON SOCIALE ─────────────────────────────
// « MAELLE RASSENT (MAELLE) » porte deux noms : le corps, et ce que la parenthèse
// ajoute. Ces deux découpeurs séparent l'un de l'autre, et ils sont désormais
// L'ADRESSE UNIQUE de ce découpage : composition-domaines.js, qui compose les
// domaines, et mentions-legales.js, qui recoupe le nom sur la page lue, les
// importent tous deux d'ici.
//
// POURQUOI ICI et pas dans composition-domaines.js, qui les portait : cette
// bibliothèque est une feuille, sans aucun import. Le recoupement s'en sert donc
// sans charger au passage la résolution de noms ni la base, ce que lui coûterait
// un import de composition-domaines.js pour deux fonctions d'une ligne.
//
// CANDIDATE au même rapatriement, VOLONTAIREMENT PAS FAITE DANS CE COMMIT :
// server/services/rapprochement-atout-france.js porte, dans aiguillesNom(), une
// TROISIÈME copie de la même règle (la même boucle sur /\(([^)]*)\)/g, le même
// remplacement de /\([^)]*\)/g par une espace). Trois adresses pour un seul
// découpage, c'est de là que naît la divergence ; ce rapatriement-là touche un
// autre moteur et mérite son propre commit. PURS.
export const horsParentheses = (s) => String(s || '').replace(/\([^)]*\)/g, ' ')
export const parentheses = (s) => [...String(s || '').matchAll(/\(([^)]*)\)/g)].map(m => m[1])

// ── Rapprochement d'ADRESSE (pont OSM nom+adresse) ──────────────────────────
// Purs, sans I/O. Réduisent l'asymétrie de représentation de la voie :
//   société = voie ÉCLATÉE (numero_voie / type_voie / libelle_voie),
//   OSM     = `street` en CHAÎNE UNIQUE + `housenumber` séparé.

// Types de voie → forme canonique unique. Applique token par token APRÈS
// normalisation, pour que l'abréviation Etalab (RUE, AV, BD…) et la forme pleine
// OSM (Rue, Avenue, Boulevard…) convergent vers la même clé. Couvre les codes
// type_voie Etalab courants.
const TYPES_VOIE = {
  av: 'avenue', ave: 'avenue',
  bd: 'boulevard', bld: 'boulevard',
  r: 'rue',
  pl: 'place',
  imp: 'impasse',
  che: 'chemin', chem: 'chemin',
  all: 'allee',
  sq: 'square',
  rte: 'route',
  crs: 'cours',
  pass: 'passage', pas: 'passage',
  fg: 'faubourg',
  // Codes type_voie Etalab/AFNOR complémentaires (l'agrégat adresse abrège en
  // MAJUSCULES, ex. "CRS", "RPT", "QU"). Convergent vers la même clé que la forme
  // pleine OSM ("Cours", "Rond-Point", "Quai").
  car: 'carrefour', crf: 'carrefour',
  chs: 'chaussee',
  cite: 'cite',
  dsc: 'descente',
  esp: 'esplanade',
  ham: 'hameau',
  lot: 'lotissement',
  mte: 'montee',
  prom: 'promenade',
  prv: 'parvis',
  qu: 'quai', quai: 'quai',
  res: 'residence',
  rle: 'ruelle',
  rpt: 'rond point',
  sen: 'sente',
  tra: 'traverse',
  vla: 'villa',
  vlge: 'village',
  // Voies « sans voie » : lieu-dit et zones d'activité. L'agrégat Etalab abrège
  // ("LD LES PINS", "ZA DU MOULIN") là où OSM et les pages web écrivent la forme
  // pleine ("Lieu-dit Les Pins", "Zone Artisanale du Moulin"). Les trois sigles de
  // zone ne sont PAS synonymes entre eux : chacun garde son expansion propre.
  ld: 'lieu dit', lieudit: 'lieu dit',
  za: 'zone artisanale', zi: 'zone industrielle', zac: 'zone amenagement concerte',
  // Abréviations de LIBELLÉ fréquentes (dédicataire de voie) : l'agrégat Etalab
  // abrège ("MAL LECLERC", "GAL DE GAULLE") là où OSM écrit en toutes lettres
  // ("Maréchal Leclerc", "Général de Gaulle"). Mappées pour converger.
  mal: 'marechal',
  gal: 'general',
  cdt: 'commandant', cmdt: 'commandant',
  pdt: 'president',
  dr: 'docteur',
  st: 'saint', ste: 'sainte'
}

// Mots-outils non discriminants, retirés SYMÉTRIQUEMENT des deux sources : sans
// ça "rue des lilas" (OSM, article présent) ≠ "rue lilas" (société, article omis).
const MOTS_OUTILS_VOIE = new Set(['de', 'des', 'du', 'la', 'le', 'les', 'l', 'd'])

// Pipeline texte commun (calque de normText, inliné pour garder lib/societes.js
// sans dépendance) : minuscules · accents NFD retirés · non-alphanum → espace ·
// espaces compactés · trim. Retourne la liste des tokens (vide si rien).
function _tokensVoie(s) {
  const t = String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return t ? t.split(' ') : []
}

// type + libelle → clé canonique du LIBELLÉ de voie, NUMÉRO EXCLU. Côté OSM :
// passer `street` entier en `libelle`, `type` vide (le type y est déjà dans la
// chaîne). Côté société : les 3 champs éclatés (numero_voie N'entre PAS ici).
//   normaliserVoie('RUE', 'DES LILAS')  -> 'rue lilas'
//   normaliserVoie('', 'Rue des Lilas') -> 'rue lilas'
// Retourne '' si vide (→ jamais de clé voie vide, pas de faux match L3). PUR.
export function normaliserVoie(type, libelle) {
  const tokens = _tokensVoie(`${type || ''} ${libelle || ''}`)
  const out = []
  for (const tok of tokens) {
    if (MOTS_OUTILS_VOIE.has(tok)) continue        // article/préposition → retiré
    out.push(TYPES_VOIE[tok] || tok)               // abréviation → forme pleine, sinon inchangé
  }
  return out.join(' ')
}

// Jumeau CHAÎNE de normaliserVoie, pour chercher une voie dans un TEXTE LIBRE (une
// page web) et non dans un champ d'adresse. MÊME pipeline, MÊMES tables — donc même
// forme canonique des deux côtés de la comparaison —, mais par substitutions de
// chaîne : un corpus de plusieurs mégaoctets n'est jamais éclaté en tableau de
// jetons. Les deux regex sont construites UNE fois depuis TYPES_VOIE et
// MOTS_OUTILS_VOIE : aucune liste dupliquée, rien à tenir à jour en double.
//   canoniserTexteVoie('Nous sommes au 8 r. des Boucheries')
//     -> 'nous sommes au 8 rue boucheries'
// Ordre calqué sur normaliserVoie : mots-outils retirés d'abord, types de voie
// canonisés ensuite (les deux tables sont disjointes, l'ordre n'a de toute façon
// aucun effet — il est fixé pour que les deux fonctions se lisent pareil). PUR.
const RE_MOTS_OUTILS_VOIE = new RegExp('\\b(?:' + [...MOTS_OUTILS_VOIE].join('|') + ')\\b', 'g')
const RE_TYPES_VOIE = new RegExp('\\b(' + Object.keys(TYPES_VOIE).join('|') + ')\\b', 'g')

export function canoniserTexteVoie(texte) {
  return String(texte || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(RE_MOTS_OUTILS_VOIE, ' ')
    .replace(RE_TYPES_VOIE, (m) => TYPES_VOIE[m])
    .replace(/\s+/g, ' ')
    .trim()
}

// Concordance de numéro de voie. OSM `housenumber` peut valoir '12 bis', '12-14' ;
// société `numero_voie` est en principe purement numérique. On compare le PREMIER
// groupe de chiffres de chaque côté. Numéro absent d'un côté → false (non
// concordant : dégrade L3→L2, jamais un rejet). PUR.
export function comparerNumero(numSoc, housenumberOsm) {
  const a = String(numSoc || '').match(/\d+/)
  const b = String(housenumberOsm || '').match(/\d+/)
  if (!a || !b) return false
  return a[0] === b[0]
}

// ── DÉCOUPE D'UNE ADRESSE AGRÉGÉE ───────────────────────────────────────────
// Une adresse agrégée (le champ libre `adresse` d'Etalab, l'`address` monobloc
// d'une carte pipeline, le libellé rendu par la BAN) se découpe en TROIS
// parties : la voie telle quelle, le code postal, la ville.
//
// DOCTRINE, et c'est la raison d'être de cette fonction : L'ANCRE EST EN FIN.
// Le code postal est le DERNIER bloc de cinq chiffres de la chaîne. Tout bloc
// de cinq chiffres situé AVANT le dernier est un code de service (CS, BP, TSA,
// numéro de local, cedex), JAMAIS un code postal. L'agrégat porte son code
// postal en fin, suivi de la ville quand elle y est : c'est ce qui INTERDIT
// d'ancrer au début. Une découpe ancrée au début coupe sur « CS 20101 », laisse
// « 35270 COMBOURG » dans la voie, et la clé de voie devient morte d'avance
// (elle porte des chiffres, aucune voie OSM n'en porte).
//
// La ville est FACULTATIVE : « 28 RUE DE LA ROUELLE 35120 » se découpe tout
// aussi bien, ville vide. Sans aucun bloc de cinq chiffres, tout part dans la
// voie et les deux autres parties restent vides : rien n'est fabriqué.
//
// La ponctuation qui borde le code postal est tolérée des deux côtés
// (« 8 rue des Boucheries, 22000 Saint-Brieuc »).
//
//   '12 RUE DES LILAS 75011 PARIS'  -> { voie:'12 RUE DES LILAS', code_postal:'75011', ville:'PARIS' }
//   'CS 20101 35270 COMBOURG'       -> { voie:'CS 20101',         code_postal:'35270', ville:'COMBOURG' }
//   '28 RUE DE LA ROUELLE 35120'    -> { voie:'28 RUE DE LA ROUELLE', code_postal:'35120', ville:'' }
//   'LIEU DIT LES PINS'             -> { voie:'LIEU DIT LES PINS', code_postal:'', ville:'' }
//
// PUR, testable hors DB. Jumeau NAVIGATEUR : public/js/adresse-agregee.js, à
// garder synchronisé (le front est en scripts classiques, sans import ESM).
export function decouperAdresseAgregee(adresse) {
  const raw = String(adresse || '').trim()
  if (!raw) return { voie: '', code_postal: '', ville: '' }
  // `(.*)` GLOUTON : le moteur recule depuis la FIN, le premier bloc de cinq
  // chiffres qu'il rencontre est donc le DERNIER de la chaîne. La doctrine tient
  // dans ce seul quantificateur ; le rendre paresseux la retournerait.
  const m = raw.match(/^(.*)[\s,;]*\b(\d{5})\b[\s,;]*(.*)$/)
  if (!m) return { voie: raw, code_postal: '', ville: '' }
  return {
    voie: m[1].trim().replace(/[\s,;]+$/, ''),
    code_postal: m[2],
    ville: m[3].trim()
  }
}

// Adresse Etalab AGRÉGÉE → { numero, voie, code_postal, ville }. Etalab ne
// peuple JAMAIS type_voie / libelle_voie éclatés, mais le champ libre `adresse`
// l'est ("<num> <type> <libellé> <CP> <ville>"). On en dérive numéro + clé de
// voie pour rouvrir le L3 (sans quoi voieSoc est vide → jamais de match
// d'adresse exact), et on rend AUSSI le code postal et la ville : un appelant
// qui les veut n'a plus à reconstituer un agrégat pour se les faire redécouper.
//   "12 RUE DES LILAS 75011 PARIS"        -> { numero:'12', voie:'rue lilas', code_postal:'75011', ville:'PARIS' }
//   "BAT A 3 AV DU GAL DE GAULLE 69003 …" -> { numero:'3',  voie:'avenue general gaulle', … }
// Étapes : (a) découpe par decouperAdresseAgregee, doctrine comprise ; (b) 1er
// groupe de chiffres de la voie = numéro, le SUFFIXE après ce groupe = voie
// brute (un complément en tête, AVANT le numéro, est donc écarté) ; (c) voie =
// normaliserVoie('', brut).
//
// ATTENTION : sous le même nom, les deux fonctions ne rendent PAS la même
// chose. `voie` vaut ici la CLÉ CANONIQUE, comparable à normaliserVoie('',
// osm.street) ; decouperAdresseAgregee rend le texte de voie TEL QUEL, celui
// qu'on affiche ou qu'on pose dans un formulaire.
// Tout vide si l'entrée l'est. PUR, testable hors DB.
export function parserAdresseAgregee(adresse) {
  const { voie: corps, code_postal, ville } = decouperAdresseAgregee(adresse)
  if (!corps) return { numero: '', voie: '', code_postal, ville }
  // (b) 1er groupe de chiffres = numéro ; ce qui SUIT ce groupe = voie brute.
  const m = corps.match(/\d+/)
  if (m) {
    let brut = corps.slice(m.index + m[0].length)
    // Indice de répétition accolé au numéro ("12 BIS", "3 TER", "5 B") : côté OSM
    // il vit dans housenumber, PAS dans street. On le retire du libellé de voie,
    // sinon "bis rue paradis" ≠ "rue paradis" et le L3 casse sur les adresses bis.
    brut = brut.replace(/^\s*(bis|ter|quater|quinquies|[a-z])\b/i, ' ')
    return { numero: m[0], voie: normaliserVoie('', brut), code_postal, ville }
  }
  // (c) pas de numéro : toute la voie découpée est le libellé.
  return { numero: '', voie: normaliserVoie('', corps), code_postal, ville }
}

// Ensemble des TYPES de voie, IGNORÉS lors de la corroboration. Liste EXPLICITE de
// types réels (formes pleines + abréviations Etalab/DataForSEO), SANS les dédicataires :
// "marechal", "general", "commandant", "president", "docteur", "saint"/"sainte" sont des
// noms propres de rue, jamais des types à retirer — les inclure risquerait de gommer un
// nom propre en tête et d'ouvrir un faux positif. "cr" est conservé (abréviation
// DataForSEO de "cours" que TYPES_VOIE ne mappe pas — il ne connaît que "crs").
const TYPES_DE_VOIE = new Set([
  'rue', 'r', 'avenue', 'av', 'ave', 'cours', 'cr', 'crs', 'place', 'pl',
  'chemin', 'che', 'chem', 'impasse', 'imp', 'boulevard', 'bd', 'bld', 'allee', 'all',
  'route', 'rte', 'quai', 'qu', 'passage', 'pass', 'pas', 'square', 'sq', 'faubourg', 'fg',
  'ruelle', 'rle', 'sente', 'sen', 'montee', 'mte', 'promenade', 'prom', 'esplanade', 'esp',
  'cite', 'hameau', 'ham', 'lotissement', 'lot', 'residence', 'res', 'villa', 'vla',
  'village', 'vlge', 'traverse', 'tra', 'chaussee', 'chs', 'descente', 'dsc',
  'carrefour', 'car', 'crf', 'parvis', 'prv', 'rond', 'point', 'rpt'
])

// Retire le PREMIER token s'il est un type de voie connu (TYPES_DE_VOIE) : le type ne
// participe PAS à la corroboration. Ne retire qu'UN token, et seulement en tête —
// "rue rue" garde son 2e "rue". PUR.
function _sansTypeEnTete(tokens) {
  return tokens.length && TYPES_DE_VOIE.has(tokens[0]) ? tokens.slice(1) : tokens
}

// Concordance TOLÉRANTE de deux LIBELLÉS de voie DÉJÀ normalisés (sortie de
// normaliserVoie / parserAdresseAgregee). Le TYPE DE VOIE est IGNORÉ (décision
// assumée : "30 rue Marceau" ≡ "30 avenue Marceau" dès lors que numéro + CP + noms
// propres concordent) : on retire le type en tête de chaque côté, puis on corrobore
// les NOMS PROPRES restants. Absorbe aussi les abréviations DataForSEO que TYPES_VOIE
// ne couvre PAS (ex. "doct" pour "docteur") par troncature positionnelle, SANS ouvrir
// la porte aux faux positifs (deux rues distinctes du même quartier).
// Règle : après retrait du type en tête, MÊME nombre de noms propres (>= 1 de chaque
// côté) ET, pour chaque paire (token i, token i), soit égalité exacte, soit l'un est
// préfixe de l'autre avec le plus court faisant >= 2 caractères. Nombre de noms
// propres différent OU un seul non concordant → false. Plus aucun nom propre après
// retrait du type (voie vide, ou réduite au seul type) → false (jamais de match sur
// du vide).
//   voiesConcordent('rue marceau',              'avenue marceau')       -> true  (type ignoré)
//   voiesConcordent('avenue general de gaulle', 'av general de gaulle') -> true  (type ignoré)
//   voiesConcordent('cours docteur jacques noel','cr doct jacques noel')-> true  (type ignoré, doct⊂docteur)
//   voiesConcordent('rue du port',              'avenue de paris')      -> false (noms propres distincts)
//   voiesConcordent('rue victor hugo',          'rue victor')           -> false (nb noms propres ≠)
//   voiesConcordent('rue roosevelt',            'rue r')                -> false (préfixe < 2 car)
// Choix ASSUMÉ : 'rue lilas' vs 'rue lila' concordent (lila⊂lilas, 4 car >= 2) — on
// tolère la variante orthographique proche, jugée acceptable au regard du risque de
// rater une vraie concordance. PUR, sans I/O.
export function voiesConcordent(voieA, voieB) {
  const a = _sansTypeEnTete(_tokensVoie(voieA))
  const b = _sansTypeEnTete(_tokensVoie(voieB))
  if (a.length === 0 || b.length === 0) return false   // plus aucun nom propre → jamais concordant
  if (a.length !== b.length) return false              // nombre de noms propres différent → rejet
  for (let i = 0; i < a.length; i++) {
    if (!_tokensConcordent(a[i], b[i])) return false   // un seul nom propre divergent → rejet
  }
  return true
}

// Deux tokens concordent : égalité exacte OU l'un préfixe de l'autre, le plus court
// faisant >= 2 caractères (empêche qu'une initiale "r" happe "roosevelt"). PUR.
function _tokensConcordent(x, y) {
  if (x === y) return true
  const [court, long] = x.length <= y.length ? [x, y] : [y, x]
  if (court.length < 2) return false
  return long.startsWith(court)
}

// ── Distance entre deux points, pour le pont OSM par le nom ──────────────
// Projection équirectangulaire locale, REPRISE TELLE QUELLE du banc qui a validé
// la règle "nom exact + 100 m" (scripts/diag-osm-nom-commune-gain.mjs) : le pont
// doit mesurer exactement comme la mesure qui l'autorise, pas approcher son
// résultat. Rend des KILOMÈTRES. Largement suffisante à cette échelle : à 100 m,
// l'écart à la géodésique est très en deçà de la précision des coordonnées.
//
// PIÈGE, porté tel quel lui aussi : la garde ne teste que null. Une coordonnée
// undefined ou NaN la traverse et rend NaN, or `NaN > seuil` est FAUX, donc la
// comparaison ACCEPTERAIT le candidat au lieu de l'écarter. Les appelants
// coercent en null (Number.isFinite) AVANT l'appel, comme le faisait le banc.
// PUR, sans I/O.
export function distKm(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some(v => v === null)) return Infinity
  const x = (bLng - aLng) * Math.cos((aLat + bLat) * Math.PI / 360)
  return Math.sqrt(x * x + (bLat - aLat) ** 2) * 111.32
}
