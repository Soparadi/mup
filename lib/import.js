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
  url: ['url']
}

const REVERSE_ENTETES = (() => {
  const m = {}
  for (const [canon, list] of Object.entries(SYNONYMES)) for (const s of list) m[s] = canon
  return m
})()

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

function trouverCanon(nh) {
  if (!nh) return null
  // Toute en-tête LinkedIn : société si elle cite une entité, sinon personne.
  if (nh.includes('linkedin')) {
    return MOTS_SOCIETE.some(m => nh.includes(m)) ? 'linkedin_entreprise' : 'linkedin'
  }
  // "nom <entité>" -> société, jamais patronyme (priorité sur le canon 'nom').
  if (/\bnom\b/.test(nh) && MOTS_SOCIETE.some(m => nh.includes(m))) return 'societe'
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

function normaliserGrille(rows) {
  if (!rows.length) return []
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
  const lignes = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const acc = {
      prenom: '', nom: '', nom_complet: '', poste: '', societe: '',
      email: '', tel: '', linkedin: '', linkedin_entreprise: '', site: '',
      adresse: '', ville: '', cp: ''
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
      if (acc[key] !== undefined) { if (!acc[key]) acc[key] = v; return }
      sniff(acc, v)
    })
    let prenom = acc.prenom
    let nom = acc.nom
    if (!prenom && !nom && acc.nom_complet) {
      const parts = acc.nom_complet.split(/\s+/)
      if (parts.length === 1) nom = parts[0]
      else { prenom = parts[0]; nom = parts.slice(1).join(' ') }
    }
    // nom_complet capté comme société (format prospection) sans personne.
    if (!acc.societe && nomEstSociete && acc.nom_complet) acc.societe = acc.nom_complet
    lignes.push({
      prenom, nom, poste: acc.poste, societe: acc.societe,
      email: (acc.email || '').toLowerCase(), tel: acc.tel,
      linkedin: acc.linkedin, linkedin_entreprise: acc.linkedin_entreprise,
      site: acc.site, adresse: acc.adresse, ville: acc.ville, cp: acc.cp, source
    })
  }
  return lignes
}

// ─────────────────────────────────────────────────────────────────────────
// 5. DÉTECTION DU FORMAT + PARSING -> lignes normalisées
// ─────────────────────────────────────────────────────────────────────────

function lignesDepuisFichier(filename, buffer) {
  const name = String(filename || '').toLowerCase()
  // Signature binaire prioritaire sur l'extension.
  const isZip = buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b // PK
  if (name.endsWith('.xlsx') || isZip) return normaliserGrille(lireXlsx(buffer))
  const text = buffer.toString('utf8')
  if (name.endsWith('.vcf') || /BEGIN:VCARD/i.test(text.slice(0, 64))) return parseVCard(text)
  return normaliserGrille(parseCSV(text))
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
      email: '', tel: '', site: '', linkedin: '', adresse: '', ville: '', cp: ''
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
  for (const k of ['email', 'tel', 'site', 'adresse', 'ville', 'cp']) {
    if (!s[k] && l[k]) s[k] = l[k]
  }
  const li = l.linkedin_entreprise || l.linkedin
  if (!s.linkedin && li) s.linkedin = li
}

function enrichirPersonne(a, b) {
  for (const k of ['prenom', 'nom', 'poste', 'email', 'tel', 'linkedin']) {
    if (!a[k] && b[k]) a[k] = b[k]
  }
  if (a.statut === 'reserve' && b.statut === 'pro') a.statut = 'pro'
  if (!a.societe_cle && b.societe_cle) a.societe_cle = b.societe_cle
}

function construirePlan(lignes) {
  const societes = new Map()
  const personnes = new Map()
  let nbDoublons = 0

  for (const l of lignes) {
    const nomPersonne = [l.prenom, l.nom].filter(Boolean).join(' ').trim()
    const aPersonne = !!nomPersonne
    const cleSociete = normaliserSociete(l.societe)
    const nomPersonneNorm = normaliserSociete(nomPersonne)
    const emailPro = estEmailPro(l.email)
    const hasSociete = !!cleSociete
    const independant = hasSociete && !!nomPersonneNorm && cleSociete === nomPersonneNorm
    const societeTierce = hasSociete && !independant

    // Entité pure : pas de personne, juste une société -> société seule.
    if (!aPersonne && hasSociete) {
      const s = ensureSociete(societes, cleSociete, l.societe, l.source)
      attacherCoords(s, l)
      continue
    }

    // Statut + résolution société (création conditionnelle).
    let statut
    let societeCleFinal = null
    if (societeTierce) {
      statut = 'pro'
      societeCleFinal = cleSociete
      const s = ensureSociete(societes, cleSociete, l.societe, l.source)
      // LinkedIn de société rattaché à la face entreprise, jamais à la personne.
      if (l.linkedin_entreprise && !s.linkedin) s.linkedin = l.linkedin_entreprise
    } else if (independant) {
      // indépendant : la société est lui-même -> societe_id null.
      statut = 'pro'
      societeCleFinal = null
    } else {
      // Aucune société : preuve pro = email pro ou poste, sinon réserve.
      statut = emailPro || l.poste ? 'pro' : 'reserve'
      societeCleFinal = null
    }

    const personne = {
      prenom: l.prenom, nom: l.nom, poste: l.poste,
      email: l.email, tel: l.tel, linkedin: l.linkedin,
      source: l.source, statut, societe_cle: societeCleFinal, action: 'creer'
    }

    // Clé de résolution : email, sinon nom normalisé + clé société.
    const key = l.email
      ? 'e:' + l.email
      : 'n:' + nomPersonneNorm + '|' + (societeCleFinal || '')
    const existant = personnes.get(key)
    if (existant) {
      enrichirPersonne(existant, personne)
      nbDoublons++
    } else {
      personnes.set(key, personne)
    }
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
export function analyserImport(filename, buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  const lignes = lignesDepuisFichier(filename, buf)
  return construirePlan(lignes)
}
