// Moteur d'import contacts multi-format — logique PURE, ZÉRO écriture DB.
// Aucune dépendance npm : le lecteur xlsx est écrit en JS natif au-dessus de
// zlib (module Node natif). CSV et vCard sont parsés en texte natif.
//
// Surface publique :
//   analyserImport(filename, buffer) -> { societes, personnes, stats }
//   lireXlsx(buffer) -> [[col1, col2, ...], ...]   (lignes brutes)
//
// Le rapprochement sociétés réutilise normaliserSociete (lib/societes.js) pour
// rester cohérent avec les routes /api/societes.

import zlib from 'zlib'
import { normaliserSociete } from './societes.js'

// ─────────────────────────────────────────────────────────────────────────
// 1. LECTEUR XLSX MAISON (ZIP via zlib natif)
// Un .xlsx est une archive ZIP (signature PK) contenant des XML. On lit le
// répertoire central (End Of Central Directory) qui porte les tailles fiables,
// puis on décompresse xl/sharedStrings.xml et xl/worksheets/sheet1.xml.
// ─────────────────────────────────────────────────────────────────────────

const SIG_EOCD = 0x06054b50 // PK\x05\x06 — fin du répertoire central
const SIG_CDIR = 0x02014b50 // PK\x01\x02 — entrée du répertoire central
const SIG_LOCAL = 0x04034b50 // PK\x03\x04 — en-tête local de fichier

// Parcourt le répertoire central et retourne { nom: { method, compSize, localOff } }.
function lireZipEntries(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('xlsx : archive ZIP invalide (EOCD introuvable)')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = {}
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CDIR) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries[name] = { method, compSize, localOff }
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// Décompresse une entrée nommée -> string UTF-8 (ou null si absente).
// L'en-tête LOCAL est relu : sa longueur de champ extra peut différer du
// répertoire central, c'est lui qui donne le vrai début des données.
function extraireFichier(buf, entries, name) {
  const e = entries[name]
  if (!e) return null
  if (buf.readUInt32LE(e.localOff) !== SIG_LOCAL) return null
  const nameLen = buf.readUInt16LE(e.localOff + 26)
  const extraLen = buf.readUInt16LE(e.localOff + 28)
  const start = e.localOff + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + e.compSize)
  if (e.method === 0) return data.toString('utf8')        // stored
  if (e.method === 8) return zlib.inflateRawSync(data).toString('utf8') // deflate
  throw new Error('xlsx : méthode de compression non supportée (' + e.method + ')')
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
}

// "A1" / "AB12" -> index de colonne 0-based.
function colToIndex(ref) {
  const m = String(ref).match(/^([A-Za-z]+)/)
  if (!m) return -1
  let n = 0
  for (const c of m[1].toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64)
  return n - 1
}

// Index 0-based -> lettre de colonne ("A", "B", … "AA"). Sert d'identifiant
// stable d'une colonne entre le dryrun et le mapping renvoyé par le client.
function indexToCol(i) {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// Table des chaînes partagées. Les <si/> vides sont préservés pour ne pas
// décaler les index référencés par les cellules t="s".
function parseSharedStrings(xml) {
  if (!xml) return []
  const normalise = xml.replace(/<si\b[^>]*\/>/g, '<si></si>')
  const out = []
  const reSi = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m
  while ((m = reSi.exec(normalise))) {
    let text = ''
    const reT = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let t
    while ((t = reT.exec(m[1]))) text += decodeXml(t[1])
    out.push(text)
  }
  return out
}

function parseSheet(xml, shared) {
  const rows = []
  const reRow = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let r
  while ((r = reRow.exec(xml))) {
    const cells = []
    const reCell = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let c
    while ((c = reCell.exec(r[1]))) {
      const attrs = c[1] || ''
      const body = c[2] || ''
      const ref = (attrs.match(/\br="([A-Za-z]+)\d+"/) || [])[1] || ''
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n'
      let val = ''
      if (type === 'inlineStr') {
        const reT = /<t\b[^>]*>([\s\S]*?)<\/t>/g
        let t
        while ((t = reT.exec(body))) val += decodeXml(t[1])
      } else {
        const vm = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)
        const raw = vm ? decodeXml(vm[1]) : ''
        val = type === 's' ? (shared[Number(raw)] || '') : raw
      }
      const idx = ref ? colToIndex(ref) : cells.length
      if (idx >= 0) cells[idx] = val
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = ''
    rows.push(cells)
  }
  return rows.filter(row => row.some(c => c && String(c).trim()))
}

export function lireXlsx(buf) {
  const entries = lireZipEntries(buf)
  const sharedXml = extraireFichier(buf, entries, 'xl/sharedStrings.xml') || ''
  let sheetName = 'xl/worksheets/sheet1.xml'
  if (!entries[sheetName]) {
    sheetName =
      Object.keys(entries).find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)) ||
      Object.keys(entries).find(k => /^xl\/worksheets\/.+\.xml$/.test(k)) ||
      ''
  }
  const sheetXml = sheetName ? extraireFichier(buf, entries, sheetName) : ''
  if (!sheetXml) return []
  return parseSheet(sheetXml, parseSharedStrings(sharedXml))
}

// ─────────────────────────────────────────────────────────────────────────
// 2. PARSING CSV NATIF (guillemets, virgules/;/tab, CRLF, BOM UTF-8)
// ─────────────────────────────────────────────────────────────────────────

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

// Séparateur déduit de la 1re ligne (hors guillemets) : ; \t puis , .
function detecterSeparateur(text) {
  let line = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') { inQ = !inQ; continue }
    if (!inQ && (ch === '\n' || ch === '\r')) break
    line += ch
  }
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let q = false
  for (const ch of line) {
    if (ch === '"') { q = !q; continue }
    if (!q && ch in counts) counts[ch]++
  }
  if (counts[';'] >= counts[','] && counts[';'] >= counts['\t']) return ';'
  if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) return '\t'
  return ','
}

export function parseCSV(text) {
  text = stripBom(String(text || ''))
  const sep = detecterSeparateur(text)
  const rows = []
  let row = []
  let field = ''
  let inQ = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQ = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQ = true; i++; continue }
    if (ch === sep) { row.push(field); field = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += ch; i++
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
    .map(r => r.map(c => String(c).trim()))
    .filter(r => r.some(c => c))
}

// ─────────────────────────────────────────────────────────────────────────
// 3. PARSING vCARD .vcf NATIF (iPhone)
// ─────────────────────────────────────────────────────────────────────────

function unescapeVcard(v) {
  return String(v)
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
}

export function parseVCard(text) {
  // Dépliage des lignes repliées (continuation = ligne débutant par espace/tab).
  const raw = stripBom(String(text || '')).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = []
  for (const ligne of raw.split('\n')) {
    if (/^[ \t]/.test(ligne) && lines.length) lines[lines.length - 1] += ligne.slice(1)
    else lines.push(ligne)
  }
  const fiches = []
  let cur = null
  for (const ligne of lines) {
    const up = ligne.toUpperCase()
    if (up.startsWith('BEGIN:VCARD')) { cur = {}; continue }
    if (up.startsWith('END:VCARD')) { if (cur) fiches.push(cur); cur = null; continue }
    if (!cur) continue
    const sep = ligne.indexOf(':')
    if (sep < 0) continue
    const left = ligne.slice(0, sep)
    const value = ligne.slice(sep + 1)
    const prop = left.split(';')[0].toUpperCase().replace(/^ITEM\d+\./, '')
    if (prop === 'FN') cur.fn = unescapeVcard(value)
    else if (prop === 'N') {
      const parts = value.split(';')
      cur.nom = unescapeVcard(parts[0] || '')
      cur.prenom = unescapeVcard(parts[1] || '')
    } else if (prop === 'ORG') cur.org = unescapeVcard(value.split(';')[0] || '')
    else if (prop === 'TITLE') cur.title = unescapeVcard(value)
    else if (prop === 'EMAIL' && !cur.email) cur.email = unescapeVcard(value)
    else if (prop === 'TEL' && !cur.tel) cur.tel = unescapeVcard(value)
    else if (prop === 'URL') {
      const u = unescapeVcard(value)
      if (/linkedin\./i.test(u)) cur.linkedin = u
      else if (!cur.site) cur.site = u
    }
  }
  return fiches.map(f => {
    let prenom = f.prenom || ''
    let nom = f.nom || ''
    if (!prenom && !nom && f.fn) {
      const parts = f.fn.split(/\s+/)
      if (parts.length === 1) nom = parts[0]
      else { prenom = parts[0]; nom = parts.slice(1).join(' ') }
    }
    return {
      prenom, nom, poste: f.title || '', societe: f.org || '',
      email: (f.email || '').toLowerCase(), tel: f.tel || '',
      linkedin: f.linkedin || '', site: f.site || '',
      adresse: '', ville: '', cp: '', source: 'iphone'
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────
// 4. NORMALISATION DES GRILLES (csv / xlsx) -> lignes normalisées
// ─────────────────────────────────────────────────────────────────────────

function normHeader(h) {
  return String(h || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// En-tête normalisé -> champ canonique. 'url' reste ambigu et est tranché plus
// tard (linkedin vs site) selon son contenu.
const SYNONYMES = {
  prenom: ['prenom', 'first name', 'given name', 'firstname'],
  nom: ['nom', 'last name', 'family name', 'lastname', 'surname', 'nom de famille'],
  nom_complet: ['name', 'nom complet', 'full name', 'display name', 'contact', 'nom contact', 'contact nom', 'prenom nom', 'nom et prenom', 'contact name', 'dirigeant', 'exploitant', 'gerant', 'responsable', 'interlocuteur'],
  poste: ['poste', 'position', 'job title', 'title', 'fonction', 'titre', 'organization 1 title', 'intitule du poste', 'role'],
  societe: ['societe', 'company', 'entreprise', 'organisation', 'organization', 'organization 1 name', 'employeur', 'raison sociale', 'agence', 'etablissement', 'nom etablissement', 'enseigne', 'nom entreprise', 'nom de l entreprise', 'nom de l agence', 'nom du camping', 'nom de l etablissement', 'nom de la societe', 'denomination', 'nom commercial'],
  email: ['email', 'e mail', 'mail', 'courriel', 'email address', 'e mail address', 'e mail 1 value', 'adresse email', 'email 1', 'adresse e mail', 'email professionnel', 'e mail value'],
  tel: ['tel', 'telephone', 'phone', 'mobile', 'mobile phone', 'business phone', 'phone 1 value', 'portable', 'tel 1', 'telephone portable', 'telephone mobile', 'gsm', 'phone number', 'tel mobile'],
  linkedin: ['linkedin', 'profil linkedin', 'lien linkedin', 'url linkedin', 'linkedin dirigeant', 'linkedin contact'],
  linkedin_entreprise: ['linkedin entreprise', 'page linkedin entreprise', 'linkedin societe'],
  site: ['site', 'website', 'site web', 'url site', 'web', 'site internet', 'www'],
  adresse: ['adresse', 'address', 'rue', 'street', 'adresse postale', 'adresse 1', 'adresse 2'],
  ville: ['ville', 'city', 'commune', 'localite', 'town'],
  cp: ['cp', 'code postal', 'zip', 'postal code', 'zip code', 'codepostal'],
  forme_juridique: ['statut juridique', 'forme juridique', 'forme jur', 'statut', 'nature juridique'],
  note_societe: ['remarques', 'remarques specialites', 'specialites', 'notes', 'note', 'commentaire', 'commentaires', 'observations'],
  url: ['url']
}

const REVERSE_ENTETES = (() => {
  const m = {}
  for (const [canon, list] of Object.entries(SYNONYMES)) for (const s of list) m[s] = canon
  return m
})()

// Catalogue des champs cibles proposés dans l'écran de validation, groupés par
// face. email/tel/url restent « par valeur » : la colonne désigne la nature de
// la donnée, le routage société-vs-personne (fixe/mobile, générique/nominatif)
// reste décidé par le moteur dans construirePlan, jamais piloté par l'abonné.
export const CHAMPS_CIBLES = [
  { champ: 'societe', label: 'Nom de la société', groupe: 'Société' },
  { champ: 'site', label: 'Site web', groupe: 'Société' },
  { champ: 'linkedin_entreprise', label: 'LinkedIn société', groupe: 'Société' },
  { champ: 'adresse', label: 'Adresse', groupe: 'Société' },
  { champ: 'ville', label: 'Ville', groupe: 'Société' },
  { champ: 'cp', label: 'Code postal', groupe: 'Société' },
  { champ: 'forme_juridique', label: 'Forme / statut juridique', groupe: 'Société' },
  { champ: 'note_societe', label: 'Remarques / note société', groupe: 'Société' },
  { champ: 'prenom', label: 'Prénom', groupe: 'Personne' },
  { champ: 'nom', label: 'Nom', groupe: 'Personne' },
  { champ: 'nom_complet', label: 'Nom complet / dirigeant', groupe: 'Personne' },
  { champ: 'poste', label: 'Poste', groupe: 'Personne' },
  { champ: 'linkedin', label: 'LinkedIn personne', groupe: 'Personne' },
  { champ: 'email', label: 'Email', groupe: 'Coordonnées (routage automatique)' },
  { champ: 'tel', label: 'Téléphone', groupe: 'Coordonnées (routage automatique)' },
  { champ: 'url', label: 'URL (LinkedIn ou site, auto)', groupe: 'Coordonnées (routage automatique)' }
]

const CHAMPS_VALIDES = new Set(CHAMPS_CIBLES.map(c => c.champ))

// Mapping explicite { lettreColonne -> champ } fourni par le client : on bâtit
// directement les colKeys, sans détection auto. Un champ inconnu ou "ignorer"
// neutralise la colonne. Le routage par valeur reste appliqué en aval.
function colKeysDepuisMapping(headers, mapping) {
  return headers.map((_, i) => {
    const champ = mapping[indexToCol(i)]
    if (!champ || champ === 'ignorer' || !CHAMPS_VALIDES.has(champ)) return null
    return champ
  })
}

// Mots qui, présents dans une en-tête, désignent une ENTITÉ et non une personne.
// "Nom du camping" / "Nom de l'agence" -> société, jamais patronyme.
const MOTS_SOCIETE = [
  'entreprise', 'societe', 'agence', 'camping', 'etablissement', 'structure',
  'enseigne', 'denomination', 'commercial', 'commerciale'
]

// Canons dont les synonymes ne matchent QU'EN EXACT (jamais par inclusion).
// "Nom du camping" ne doit plus tomber en patronyme via la sous-chaîne "nom".
const CANON_EXACT_ONLY = new Set(['nom'])

// En-têtes d'index (avec valeurs entières séquentielles) -> ignorées.
const ENTETES_INDEX = new Set(['n', 'no', 'numero', 'num', 'rang', 'id', 'index'])

// En-têtes géographiques : jamais nom de société ni patronyme.
const ENTETES_GEO = new Set([
  'departement', 'dept', 'region', 'code postal', 'cp', 'ville', 'commune', 'pays'
])

// N1 — valeurs booléennes : jamais une raison sociale (ex. "partner_is_company"
// dont la valeur "True"/"False" se retrouvait en nom de société).
const RE_BOOL = /^(true|false|vrai|faux|0|1)$/i
function estBooleen(v) { return RE_BOOL.test(String(v == null ? '' : v).trim()) }

// N2(b/c) — TYPE de donnée fort déduit de l'en-tête. Prime sur les synonymes
// 'contact'/'name' qui happeraient sinon la colonne vers nom_complet :
// "Client/Contacts/Courriel" est un email, "…/Téléphone" un tél, "Fonction
// dirigeant" un poste — pas un nom.
function typeFortParEntete(nh) {
  if (nh.includes('courriel') || /\be ?mail\b/.test(nh)) return 'email'
  if (/\b(telephone|portable|mobile|gsm|phone|tel)\b/.test(nh)) return 'tel'
  if (/\b(poste|fonction)\b/.test(nh)) return 'poste'
  return null
}

// N2(d) — quand plusieurs colonnes tombent dans nom_complet, rang de
// spécificité au NOM DE PERSONNE : on garde "contact name"/"nom dirigeant"
// plutôt que la 1re colonne rencontrée (souvent un titre, ex. ODOO "name").
function rangNomComplet(nh) {
  if (/\b(contact name|nom dirigeant|nom contact|contact nom|representant|exploitant|gerant|interlocuteur)\b/.test(nh)) return 3
  if (nh.includes('dirigeant') || nh.includes('contact') || nh.includes('responsable')) return 2
  return 1
}

function trouverCanon(nh) {
  if (!nh) return null
  // N1 — drapeau booléen "partner_is_company" : jamais une société.
  if (/\bis company\b/.test(nh)) return null
  // Toute en-tête LinkedIn : société si elle cite une entité, sinon personne.
  if (nh.includes('linkedin')) {
    return MOTS_SOCIETE.some(m => nh.includes(m)) ? 'linkedin_entreprise' : 'linkedin'
  }
  // N2(b/c) — un type de donnée fort (courriel/téléphone/poste) prime sur
  // 'contact'/'name' et sauve la colonne de l'aspiration vers nom_complet.
  const tf = typeFortParEntete(nh)
  if (tf) return tf
  // N2(a) — en-tête de NOM D'ENTITÉ ("company name", "partner name", "nom
  // entreprise", "dénomination", "raison sociale"…) -> société AVANT nom_complet.
  const citeEntite = MOTS_SOCIETE.some(m => nh.includes(m)) || nh.includes('company') || nh.includes('partner')
  if (citeEntite && (/\bnom\b/.test(nh) || nh.includes('name') || nh.includes('denomination') || nh.includes('raison'))) return 'societe'
  // Correspondance exacte (gère 'nom' et tout le reste).
  if (REVERSE_ENTETES[nh]) return REVERSE_ENTETES[nh]
  // Match par inclusion, sauf 'url' et les canons exacts-only ('nom').
  for (const [canon, list] of Object.entries(SYNONYMES)) {
    if (canon === 'url' || CANON_EXACT_ONLY.has(canon)) continue
    for (const s of list) if (nh.includes(s)) return canon
  }
  return null
}

// Colonne d'index : valeurs toutes entières et strictement croissantes.
function colonneIndexSequentielle(rows, colIdx) {
  const nums = []
  for (let r = 1; r < rows.length; r++) {
    const v = String(rows[r][colIdx] == null ? '' : rows[r][colIdx]).trim()
    if (!v) continue
    if (!/^\d+$/.test(v)) return false
    nums.push(Number(v))
  }
  if (nums.length < 2) return false
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) return false
  return true
}

function detecterSource(hs) {
  const has = k => hs.includes(k)
  const some = re => hs.some(h => re.test(h))
  if (has('first name') && has('last name') && (has('connected on') || has('url'))) return 'linkedin'
  if (some(/e mail \d value/) || some(/organization \d (name|title)/) || (has('given name') && has('family name'))) return 'gmail'
  if (has('first name') && has('last name') && (has('e mail address') || has('job title') || has('business phone'))) return 'outlook'
  if ((has('adresse') || has('ville') || has('cp')) && !has('first name') && !has('prenom')) return 'prospection'
  return 'carnet'
}

const RE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const RE_TEL = /^[+(]?[\d][\d\s().+-]{6,}$/

// Filet de sécurité : une colonne d'en-tête inconnue dont la VALEUR ressemble
// fortement à un email / tél / url est tout de même captée (ne jamais perdre).
function sniff(acc, v) {
  if (RE_EMAIL.test(v)) { if (!acc.email) acc.email = v.toLowerCase(); return }
  if (/linkedin\./i.test(v)) { if (!acc.linkedin) acc.linkedin = v; return }
  if (/^https?:\/\//i.test(v)) { if (!acc.site) acc.site = v; return }
  if (RE_TEL.test(v.replace(/\s/g, '')) && /\d/.test(v)) { if (!acc.tel) acc.tel = v }
}

// Détection auto colonne -> champ canonique. Retourne aussi la source détectée
// et le flag nomEstSociete (réutilisés par le moteur et par le dryrun détaillé).
function calculerColKeys(rows) {
  const headers = rows[0]
  const hs = headers.map(normHeader)
  const source = detecterSource(hs)
  let colKeys = hs.map((nh, i) => {
    // Colonnes d'index (en-tête générique + valeurs séquentielles) -> ignorées.
    if ((ENTETES_INDEX.has(nh) || nh === '') && colonneIndexSequentielle(rows, i)) return null
    let key = trouverCanon(nh)
    if (REVERSE_ENTETES[nh] === 'url' || nh === 'url') key = 'url'
    // Garde-fou géo : jamais patronyme ni société.
    if (ENTETES_GEO.has(nh) && (key === 'nom' || key === 'nom_complet' || key === 'societe')) key = null
    return key
  })
  // Listing d'entités pures : "Nom" tient lieu de raison sociale uniquement en
  // contexte prospection SANS colonne société ni prénom distincts (sinon, une
  // colonne société identifiée + une personne distincte restent séparées).
  const aColSociete = colKeys.includes('societe')
  const aColPrenom = colKeys.includes('prenom')
  const nomEstSociete = source === 'prospection' && !aColSociete && !aColPrenom
  if (nomEstSociete) colKeys = colKeys.map(k => (k === 'nom' || k === 'nom_complet') ? 'societe' : k)
  return { headers, source, colKeys, nomEstSociete }
}

// §3 — découpe adresse / CP / ville. Ne JAMAIS écraser une colonne déjà
// renseignée séparément. CP français = bloc de 5 chiffres isolé.
function decouperAdresse(acc) {
  // CP + ville collés dans la colonne CP : "22000 Saint-Brieuc".
  if (acc.cp && !acc.ville) {
    const m = acc.cp.match(/^(\d{5})\s+(.+)$/)
    if (m) { acc.cp = m[1]; acc.ville = m[2].trim() }
  }
  // Adresse en bloc contenant un CP (seulement si le CP n'est pas déjà fourni) :
  // "12 rue des Pins 22000 Saint-Brieuc" -> adresse / cp / ville.
  if (!acc.cp && acc.adresse) {
    const m = acc.adresse.match(/^(.*?)[\s,;]*\b(\d{5})\b[\s,;]*(.*)$/)
    if (m) {
      acc.adresse = m[1].trim()
      acc.cp = m[2]
      if (!acc.ville && m[3].trim()) acc.ville = m[3].trim()
    }
  }
}

// §5 — LinkedIn routé par CONTENU d'URL, quel que soit l'en-tête d'origine :
// /company/ ou /school/ -> société ; /in/ -> personne. Le filet prime sur le
// mapping par en-tête (une page société tombée en colonne perso est corrigée).
function reclasserLinkedin(acc) {
  const estSoc = u => /\/(company|school)\//i.test(u)
  const estPers = u => /\/in\//i.test(u)
  if (acc.linkedin && estSoc(acc.linkedin) && !acc.linkedin_entreprise) {
    acc.linkedin_entreprise = acc.linkedin; acc.linkedin = ''
  }
  if (acc.linkedin_entreprise && estPers(acc.linkedin_entreprise) && !acc.linkedin) {
    acc.linkedin = acc.linkedin_entreprise; acc.linkedin_entreprise = ''
  }
}

// §5 (option) — préfixe https:// à un site web nu (domaine sans schéma).
function normaliserSite(acc) {
  if (acc.site && /^[^\s]+\.[^\s]+$/.test(acc.site) && !/^https?:\/\//i.test(acc.site)) {
    acc.site = 'https://' + acc.site
  }
}

// mappingOverride (optionnel) : { lettreColonne -> champ } validé par l'abonné.
// Fourni -> les colKeys viennent du client (détection auto débrayée pour le
// routage colonne->champ uniquement). Le routage par valeur reste en aval.
function normaliserGrille(rows, mappingOverride) {
  if (!rows.length) return []
  let headers, source, colKeys, nomEstSociete
  if (mappingOverride) {
    headers = rows[0]
    source = detecterSource(headers.map(normHeader))
    colKeys = colKeysDepuisMapping(headers, mappingOverride)
    nomEstSociete = false
  } else {
    ({ headers, source, colKeys, nomEstSociete } = calculerColKeys(rows))
  }
  // N2(d) — rang de spécificité des colonnes nom_complet (garde le nom de
  // personne le plus probable, pas la 1re colonne — ex. titre d'opportunité).
  const rangCol = colKeys.map((k, i) => k === 'nom_complet' ? rangNomComplet(normHeader(headers[i])) : 0)
  const lignes = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    let ncRang = -1
    const acc = {
      prenom: '', nom: '', nom_complet: '', poste: '', societe: '',
      email: '', tel: '', linkedin: '', linkedin_entreprise: '', site: '',
      adresse: '', ville: '', cp: '', forme_juridique: '', note_societe: ''
    }
    row.forEach((val, i) => {
      const v = String(val == null ? '' : val).trim()
      if (!v) return
      const key = colKeys[i]
      if (!key) return
      if (key === 'url') {
        if (/linkedin\./i.test(v)) { if (!acc.linkedin) acc.linkedin = v }
        else if (!acc.site) acc.site = v
        return
      }
      // Deux colonnes adresse (Adresse 1 / Adresse 2) -> concaténées.
      if (key === 'adresse') { acc.adresse = acc.adresse ? acc.adresse + ', ' + v : v; return }
      // N5 — colonnes tél/email multiples (phone + mobile, email pro + perso) :
      // concaténées, jamais écrasées. Le routage par valeur en aval tranche
      // fixe->société / mobile->personne, générique->société / nominatif->perso.
      if (key === 'tel') { acc.tel = acc.tel ? acc.tel + ' / ' + v : v; return }
      if (key === 'email') { acc.email = acc.email ? acc.email + ' / ' + v : v; return }
      // N2(d) — nom_complet : on retient la colonne au rang le plus spécifique.
      if (key === 'nom_complet') { if (rangCol[i] > ncRang) { acc.nom_complet = v; ncRang = rangCol[i] } return }
      if (acc[key] !== undefined) { if (!acc[key]) acc[key] = v; return }
      sniff(acc, v)
    })
    // §3/§5 — nettoyage des coordonnées avant assemblage de la ligne.
    decouperAdresse(acc)
    reclasserLinkedin(acc)
    normaliserSite(acc)
    // nom_complet capté comme société (format prospection) sans personne.
    if (!acc.societe && nomEstSociete && acc.nom_complet) acc.societe = acc.nom_complet
    // Le découpage prénom/nom — et le cas multi-dirigeants — est différé à
    // construirePlan, qui lit soit prenom/nom explicites soit nom_complet brut.
    // On ne pré-coupe donc plus ici : une cellule « Timothée Rolland / Théo
    // Vincent (Co-gérants) » doit rester entière pour être éclatée plus tard.
    lignes.push({
      prenom: acc.prenom, nom: acc.nom,
      nom_complet: nomEstSociete ? '' : acc.nom_complet,
      poste: acc.poste, societe: acc.societe,
      email: (acc.email || '').toLowerCase(), tel: acc.tel,
      linkedin: acc.linkedin, linkedin_entreprise: acc.linkedin_entreprise,
      site: acc.site, adresse: acc.adresse, ville: acc.ville, cp: acc.cp,
      forme_juridique: acc.forme_juridique, note_societe: acc.note_societe, source
    })
  }
  return lignes
}

// ─────────────────────────────────────────────────────────────────────────
// 5. DÉTECTION DU FORMAT + PARSING -> lignes normalisées
// ─────────────────────────────────────────────────────────────────────────

// 'xlsx' | 'vcard' | 'csv'. Signature binaire prioritaire sur l'extension.
function detecterFormat(filename, buffer) {
  const name = String(filename || '').toLowerCase()
  const isZip = buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b // PK
  if (name.endsWith('.xlsx') || isZip) return 'xlsx'
  if (name.endsWith('.vcf') || /BEGIN:VCARD/i.test(buffer.toString('utf8').slice(0, 64))) return 'vcard'
  return 'csv'
}

// N3 — ligne-titre décorative en ligne 1 (bannière mono-cellule, ou nettement
// plus pauvre que la ligne 2 qui, elle, a l'allure d'un en-tête). On la retire
// pour que rows[0] soit le VRAI en-tête. Ne se déclenche QUE sur ce motif : un
// fichier normal (en-tête déjà en ligne 1) n'est jamais modifié.
function retirerLigneTitre(rows) {
  if (rows.length < 3) return rows
  const remplies = r => r.filter(c => String(c == null ? '' : c).trim()).length
  // Ligne d'allure « en-tête » : ≥2 libellés, aucun purement numérique, aucun
  // très long (un titre/phrase n'est pas un en-tête).
  const ressembleEntete = r => {
    const vals = r.map(c => String(c == null ? '' : c).trim()).filter(Boolean)
    if (vals.length < 2) return false
    const numeriques = vals.filter(v => /^[\d\s.,€%/-]+$/.test(v)).length
    const tropLongs = vals.filter(v => v.length > 40).length
    return numeriques === 0 && tropLongs === 0
  }
  const n0 = remplies(rows[0])
  const n1 = remplies(rows[1])
  if ((n0 === 1 || n0 * 2 <= n1) && n1 >= 2 && ressembleEntete(rows[1])) return rows.slice(1)
  return rows
}

// Lignes brutes d'une grille (xlsx/csv). vCard -> rows null (passe-direct).
function grilleRows(format, buffer) {
  if (format === 'xlsx') return retirerLigneTitre(lireXlsx(buffer))
  if (format === 'csv') return retirerLigneTitre(parseCSV(buffer.toString('utf8')))
  return null
}

function lignesDepuisFichier(filename, buffer, mappingOverride) {
  const format = detecterFormat(filename, buffer)
  if (format === 'vcard') return parseVCard(buffer.toString('utf8'))
  return normaliserGrille(grilleRows(format, buffer), mappingOverride)
}

// ─────────────────────────────────────────────────────────────────────────
// 6. RÉSOLUTION : sociétés (dédup) + personnes + création conditionnelle
// ─────────────────────────────────────────────────────────────────────────

const DOMAINES_PERSO = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr', 'yahoo.co.uk',
  'hotmail.com', 'hotmail.fr', 'hotmail.co.uk', 'outlook.com', 'outlook.fr',
  'live.com', 'live.fr', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'free.fr', 'orange.fr', 'wanadoo.fr', 'sfr.fr', 'neuf.fr', 'bbox.fr',
  'laposte.net', 'gmx.com', 'gmx.fr', 'aol.com', 'protonmail.com', 'proton.me',
  'numericable.fr', 'club-internet.fr', 'voila.fr', 'yandex.com'
])

function estEmailPro(email) {
  if (!email || !email.includes('@')) return false
  const d = email.split('@')[1].toLowerCase().trim()
  return !!d && !DOMAINES_PERSO.has(d)
}

function ensureSociete(map, cle, raison, source) {
  let s = map.get(cle)
  if (!s) {
    s = {
      cle_normalisee: cle, raison_sociale: raison || '', source,
      email: '', tel: '', site: '', linkedin: '', adresse: '', ville: '', cp: '',
      forme_juridique: '', note_societe: ''
    }
    map.set(cle, s)
  } else if (!s.raison_sociale && raison) {
    s.raison_sociale = raison
  }
  return s
}

// Enrichit une société (cas entité pure) avec les coordonnées de la ligne.
// Le LinkedIn de société (colonne "LinkedIn Entreprise") prime sur un LinkedIn
// générique ; il ne va JAMAIS sur la personne.
function attacherCoords(s, l) {
  for (const k of ['site', 'adresse', 'ville', 'cp']) {
    if (!s[k] && l[k]) s[k] = l[k]
  }
  // Entité pure : aucune personne -> toutes les coordonnées vont à la société.
  // Multi-valeurs : on prend le 1er numéro/email disponible (société de préférence).
  if (!s.tel) { const t = routerTels(l.tel); const v = t.societe[0] || t.personne[0]; if (v) s.tel = v }
  if (!s.email) { const e = routerEmails(l.email); const v = e.societe[0] || e.personne[0]; if (v) s.email = v }
  const li = l.linkedin_entreprise || l.linkedin
  if (!s.linkedin && li) s.linkedin = li
  if (!s.forme_juridique && l.forme_juridique) s.forme_juridique = l.forme_juridique
  if (!s.note_societe && l.note_societe) s.note_societe = l.note_societe
}

function enrichirPersonne(a, b) {
  for (const k of ['civilite', 'prenom', 'nom', 'poste', 'email', 'tel', 'linkedin']) {
    if (!a[k] && b[k]) a[k] = b[k]
  }
  if (a.statut === 'reserve' && b.statut === 'pro') a.statut = 'pro'
  if (!a.societe_cle && b.societe_cle) a.societe_cle = b.societe_cle
}

// ── ÉTAPE 4 — classification des coordonnées (numéro / email) ──────────────

// Numéro français normalisé : espaces, points, tirets et parenthèses retirés,
// préfixe international ramené à la forme nationale 0X.
function normaliserTel(tel) {
  let t = String(tel == null ? '' : tel).replace(/[\s.()\-]/g, '')
  t = t.replace(/^\+33/, '0').replace(/^0033/, '0')
  return t
}

// 'fixe' (01-05, 09 -> société) | 'mobile' (06, 07 -> 1ère personne) |
// 'douteux' (format non reconnu, 08… -> société par défaut, prudence RGPD) | null.
function classerTelephone(tel) {
  const t = normaliserTel(tel)
  if (!t) return null
  const m = t.match(/^0([1-9])\d{8}$/)
  if (!m) return 'douteux'
  const d = m[1]
  if ('12345'.includes(d) || d === '9') return 'fixe'
  if (d === '6' || d === '7') return 'mobile'
  return 'douteux' // 08 (numéros spéciaux) -> société par défaut
}

// Parties locales génériques : l'email appartient à la SOCIÉTÉ, pas à un individu.
const EMAILS_GENERIQUES = new Set([
  'contact', 'info', 'infos', 'accueil', 'hello', 'bonjour', 'direction',
  'commercial', 'commerciale', 'reservation', 'reservations', 'secretariat',
  'administratif', 'compta', 'comptabilite', 'rh', 'sav', 'support', 'admin', 'bureau',
  'office', 'service', 'booking', 'welcome', 'mail', 'devis', 'noreply', 'no-reply'
])

// 'societe' (générique -> face société) | 'personne' (nominatif/perso -> 1ère
// personne) | null. La preuve pro d'un email perso est tranchée par estEmailPro.
function classerEmail(email) {
  const e = String(email == null ? '' : email).toLowerCase().trim()
  if (!e.includes('@')) return null
  const local = e.split('@')[0]
  const base = local.split(/[._+-]/)[0]
  if (EMAILS_GENERIQUES.has(local) || EMAILS_GENERIQUES.has(base)) return 'societe'
  return 'personne'
}

// ── Multi-valeurs (§4) — une cellule peut porter plusieurs numéros / emails ──

// Téléphones : séparés par / ; , ou retour ligne. Jamais l'espace (un numéro en
// contient). Email : séparés par / ; , ou espaces (un email n'a pas d'espace).
function separerTels(cell) {
  return String(cell == null ? '' : cell).split(/[\/;,\n\r]+/).map(s => s.trim()).filter(Boolean)
}
function separerEmails(cell) {
  return String(cell == null ? '' : cell).split(/[\/;,\s]+/).map(s => s.trim()).filter(Boolean)
}

// Route chaque numéro d'une cellule : fixe/douteux -> société, mobile -> personne.
function routerTels(cell) {
  const out = { societe: [], personne: [] }
  for (const t of separerTels(cell)) {
    if (!/\d/.test(t)) continue
    const type = classerTelephone(t)
    if (!type) continue
    if (type === 'mobile') out.personne.push(t)
    else out.societe.push(t) // fixe + douteux (08…) -> société
  }
  return out
}

// Route chaque email d'une cellule : générique -> société, nominatif -> personne.
function routerEmails(cell) {
  const out = { societe: [], personne: [] }
  for (const e of separerEmails(cell)) {
    const type = classerEmail(e)
    if (!type) continue
    if (type === 'societe') out.societe.push(e.toLowerCase())
    else out.personne.push(e.toLowerCase())
  }
  return out
}

// "Co-gérants" -> "Co-gérant" : un poste partagé au pluriel se décline au
// singulier sur chaque dirigeant. On retire seulement un 's' final.
function singulariserPoste(poste) {
  return String(poste == null ? '' : poste).replace(/s$/i, '').trim()
}

// Détache une civilité de tête ("M. Jean Dupont" -> {civilite:'M.', reste:'Jean
// Dupont'}). Mme/Madame/Mlle -> "Mme" ; M./Mr/Monsieur -> "M.". Sinon vide.
function extraireCivilite(nom) {
  const s = String(nom == null ? '' : nom)
  const m = s.match(/^\s*(mme|madame|mlle|mademoiselle|monsieur|mr|m)\.?\s+/i)
  if (!m) return { civilite: '', reste: s.trim() }
  const t = m[1].toLowerCase()
  const civ = (t === 'mme' || t === 'madame' || t === 'mlle' || t === 'mademoiselle') ? 'Mme' : 'M.'
  return { civilite: civ, reste: s.slice(m[0].length).trim() }
}

// §B — nom/prénom best-effort depuis un slug LinkedIn /in/. Isole le segment
// après /in/, retire un identifiant numérique final, sépare sur le tiret et
// Title-Case. "philippe-picou-824661104" -> { prenom:'Philippe', nom:'Picou' }.
// Non parsable (pseudo mono-token, tout chiffres) -> null. Ne décide jamais
// d'écraser : l'appelant ne complète qu'un champ vide.
export function nomDepuisLinkedin(url) {
  const m = String(url == null ? '' : url).match(/\/in\/([^/?#]+)/i)
  if (!m) return null
  let slug = m[1].replace(/-\d+$/, '').trim()    // identifiant numérique final
  if (!slug || /^\d+$/.test(slug)) return null
  const toks = slug.split('-').map(t => t.trim()).filter(Boolean)
  if (toks.length < 2) return null               // un seul token -> non séparable
  const tc = t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
  return { prenom: tc(toks[0]), nom: toks.slice(1).map(tc).join(' ') }
}

// Éclate une cellule pouvant contenir plusieurs dirigeants en personnes :
//   "Timothée Rolland / Théo Vincent (Co-gérants)"
//     -> [{prenom:'Timothée', nom:'Rolland', poste:'Co-gérant'},
//         {prenom:'Théo', nom:'Vincent', poste:'Co-gérant'}]
// Le poste entre parenthèses en fin de cellule est partagé (à défaut de colonne
// poste). Un poste propre à un dirigeant peut suivre son nom entre parenthèses.
function decouperDirigeants(brut, posteCol) {
  let txt = String(brut == null ? '' : brut).trim()
  if (!txt) return []
  let posteShared = posteCol || ''
  const mFin = txt.match(/\(([^)]+)\)\s*$/)
  if (mFin) {
    if (!posteShared) posteShared = mFin[1].trim()
    txt = txt.slice(0, mFin.index).trim()
  }
  // Séparateurs de dirigeants : / & + et "et"/"and". La virgule est exclue
  // (ambiguë avec le format « Nom, Prénom »).
  const parts = txt.split(/\s*(?:\/|&|\+|\bet\b|\band\b)\s*/i).map(s => s.trim()).filter(Boolean)
  const multi = parts.length > 1
  const gens = []
  for (let part of parts) {
    let poste = posteShared
    const m = part.match(/\(([^)]+)\)\s*$/)
    if (m) { poste = m[1].trim(); part = part.slice(0, m.index).trim() }
    else if (multi) poste = singulariserPoste(posteShared)
    const { civilite, reste } = extraireCivilite(part)
    const toks = reste.split(/\s+/).filter(Boolean)
    if (!toks.length) continue
    let prenom = '', nom = ''
    if (toks.length === 1) nom = toks[0]
    else { prenom = toks[0]; nom = toks.slice(1).join(' ') }
    gens.push({ prenom, nom, poste, civilite })
  }
  return gens
}

// Personnes portées par une ligne : colonnes prénom/nom explicites -> une seule
// personne (pas de découpage) ; sinon éclatement de la cellule nom_complet.
// Une civilité de tête sur le prénom ("M. Jean") est isolée dans tous les cas.
function personnesDeLigne(l) {
  // Deux colonnes renseignées : on les respecte (civilité isolée du prénom).
  if (l.prenom && l.nom) {
    const { civilite, reste } = extraireCivilite(l.prenom)
    return [{ prenom: reste, nom: l.nom, poste: l.poste || '', civilite }]
  }
  // §1 — colonne unique : un seul de prénom/nom rempli. Si ≥2 tokens (prénom
  // composé à trait d'union = 1 token ; particule Le/De/Du reste dans le nom),
  // découpage positionnel ; sinon le token unique reste dans sa colonne d'origine.
  if (l.prenom || l.nom) {
    const fromPrenom = !!l.prenom
    const { civilite, reste } = extraireCivilite(l.prenom || l.nom)
    const toks = reste.split(/\s+/).filter(Boolean)
    if (toks.length >= 2) {
      return [{ prenom: toks[0], nom: toks.slice(1).join(' '), poste: l.poste || '', civilite }]
    }
    return [{ prenom: fromPrenom ? reste : '', nom: fromPrenom ? '' : reste, poste: l.poste || '', civilite }]
  }
  return decouperDirigeants(l.nom_complet, l.poste)
}

function construirePlan(lignes) {
  const societes = new Map()
  const personnes = new Map()
  let nbDoublons = 0

  for (const l of lignes) {
    // N1 — une valeur booléenne (True/False/Oui/Non…) n'est jamais une raison
    // sociale (cas "partner_is_company" tombé en colonne société).
    if (l.societe && estBooleen(l.societe)) l.societe = ''
    // §2 + B5 — civilité en tête de colonne société : c'est un individu / EI.
    // On RETIRE la civilité de la raison sociale ("MADAME CELINE BRUN" ->
    // "CELINE BRUN") mais on CONSERVE la société (doctrine deux faces) pour ne
    // pas perdre adresse/cp/ville/site/coordonnées. À défaut d'autre source
    // personne, l'individu devient aussi la personne (nom_complet).
    if (l.societe) {
      const { civilite, reste } = extraireCivilite(l.societe)
      if (civilite) {
        l.societe = reste
        if (!l.prenom && !l.nom && !l.nom_complet) l.nom_complet = reste
      }
    }

    const gens = personnesDeLigne(l)
    const aPersonne = gens.length > 0
    const cleSociete = normaliserSociete(l.societe)
    const hasSociete = !!cleSociete

    // Entité pure : pas de personne, juste une société -> société seule.
    if (!aPersonne) {
      if (hasSociete) {
        const s = ensureSociete(societes, cleSociete, l.societe, l.source)
        attacherCoords(s, l)
      }
      continue
    }

    // Indépendant : un SEUL dirigeant et il EST la société (statut pro). B5 :
    // qu'il soit tiers ou indépendant/EI, dès qu'une société est présente on la
    // MATÉRIALISE et on y route les coordonnées entreprise (la face société du
    // contact lit ces champs). On ne perd plus adresse/cp/ville/site des EI.
    const nom0 = [gens[0].prenom, gens[0].nom].filter(Boolean).join(' ')
    const independant = hasSociete && gens.length === 1 &&
      normaliserSociete(nom0) === cleSociete

    // ── ÉTAPE 4 — routage des coordonnées selon leur type (§4 : multi-valeurs) ──
    // Chaque cellule tél/email est éclatée puis triée : fixe/douteux + email
    // générique -> société ; mobile + email nominatif -> 1ère personne.
    const tels = routerTels(l.tel)
    const emails = routerEmails(l.email)

    // Société présente (tierce OU EI/indépendant) : record préparé + coords.
    let societeCleFinal = null
    if (hasSociete) {
      societeCleFinal = cleSociete
      const s = ensureSociete(societes, cleSociete, l.societe, l.source)
      // LinkedIn de société rattaché à la face entreprise, jamais à la personne.
      if (l.linkedin_entreprise && !s.linkedin) s.linkedin = l.linkedin_entreprise
      if (!s.tel && tels.societe[0]) s.tel = tels.societe[0]
      if (!s.email && emails.societe[0]) s.email = emails.societe[0]
      for (const k of ['site', 'adresse', 'ville', 'cp', 'forme_juridique', 'note_societe']) {
        if (!s[k] && l[k]) s[k] = l[k]
      }
    }

    // Coords destinées à la 1ère personne : son mobile / email nominatif d'abord.
    // Repli : sans société-cible (aucune société), une coordonnée « entreprise »
    // ne se perd pas et reste sur la personne plutôt qu'être jetée.
    const telPremier = tels.personne[0] || (!hasSociete ? tels.societe[0] : '') || ''
    const emailPremier = emails.personne[0] || (!hasSociete ? emails.societe[0] : '') || ''

    gens.forEach((g, idx) => {
      const estPremier = idx === 0
      const email = estPremier ? emailPremier : ''
      const tel = estPremier ? telPremier : ''
      const linkedin = estPremier ? l.linkedin : ''
      const poste = g.poste || l.poste || ''
      // §B — nom/prénom complétés depuis le slug LinkedIn /in/ UNIQUEMENT si
      // vides ; jamais d'écrasement. Best-effort (null si slug non parsable).
      let prenom = g.prenom, nom = g.nom
      if (!nom && linkedin) {
        const li = nomDepuisLinkedin(linkedin)
        if (li) { nom = li.nom; if (!prenom) prenom = li.prenom }
      }
      // Statut : rattaché à une société (tierce ou soi-même) -> pro ; sinon
      // preuve pro = email pro ou poste, à défaut réserve.
      const statut = (hasSociete || independant || estEmailPro(email) || poste)
        ? 'pro' : 'reserve'
      const personne = {
        civilite: g.civilite || '', prenom, nom, poste,
        email, tel, linkedin,
        source: l.source, statut,
        societe_cle: societeCleFinal, action: 'creer'
      }

      // Clé de résolution : email, sinon nom normalisé + clé société.
      const nomNorm = normaliserSociete([prenom, nom].filter(Boolean).join(' '))
      const key = email ? 'e:' + email : 'n:' + nomNorm + '|' + (personne.societe_cle || '')
      const existant = personnes.get(key)
      if (existant) {
        enrichirPersonne(existant, personne)
        nbDoublons++
      } else {
        personnes.set(key, personne)
      }
    })
  }

  const listePersonnes = [...personnes.values()]
  return {
    societes: [...societes.values()],
    personnes: listePersonnes,
    stats: {
      nb_societes: societes.size,
      nb_pro: listePersonnes.filter(p => p.statut === 'pro').length,
      nb_reserve: listePersonnes.filter(p => p.statut === 'reserve').length,
      nb_doublons_evites: nbDoublons
    }
  }
}

// Point d'entrée : détecte le format, parse, résout. ZÉRO écriture DB.
// mappingOverride (optionnel) : { lettreColonne -> champ } validé par l'abonné ;
// ignoré pour vCard (passe-direct). Sans mapping -> détection auto.
export function analyserImport(filename, buffer, mappingOverride) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  const map = mappingOverride && typeof mappingOverride === 'object' ? mappingOverride : null
  const lignes = lignesDepuisFichier(filename, buf, map)
  return construirePlan(lignes)
}

// Dryrun détaillé : le plan + de quoi alimenter l'écran de validation.
//   format     : 'grille' | 'vcard'
//   headers    : en-têtes bruts (rows[0]) — [] pour vCard
//   mapping    : [{ colonne, entete_brut, champ_canonique | 'ignorer' }]
//   exemples   : 3-5 premières lignes parsées, alignées sur headers
//   champs     : catalogue des champs cibles (menu déroulant client)
// ZÉRO écriture DB. vCard : pas de mapping, plan seul.
export function analyserImportDetaille(filename, buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  const format = detecterFormat(filename, buf)
  if (format === 'vcard') {
    const plan = construirePlan(parseVCard(buf.toString('utf8')))
    return { ...plan, format: 'vcard', headers: [], mapping: [], exemples: [], champs: CHAMPS_CIBLES }
  }
  const rows = grilleRows(format, buf) || []
  const plan = construirePlan(normaliserGrille(rows))
  if (!rows.length) {
    return { ...plan, format: 'grille', headers: [], mapping: [], exemples: [], champs: CHAMPS_CIBLES }
  }
  const { headers, colKeys } = calculerColKeys(rows)
  const entetes = headers.map(h => String(h == null ? '' : h))
  const mapping = entetes.map((h, i) => ({
    colonne: indexToCol(i),
    entete_brut: h,
    champ_canonique: colKeys[i] || 'ignorer'
  }))
  const exemples = rows.slice(1, 6).map(r =>
    entetes.map((_, i) => String(r[i] == null ? '' : r[i]).trim())
  )
  return { ...plan, format: 'grille', headers: entetes, mapping, exemples, champs: CHAMPS_CIBLES }
}
