// ── Pièce signée d'un devis ───────────────────────────────────────────────
// Table dédiée `devis_signature`, un enregistrement par devis, id = id du
// devis nettoyé par cleanRecordId.
//
// POURQUOI UNE TABLE À ELLE, et non un champ de plus sur `devis` : les
// écritures qui visent un devis le remplacent en entier (POST et PUT passent
// par CONTENT, pas par MERGE). La pièce déposée par le client vivrait alors au
// milieu des champs que la page réécrit à chaque enregistrement, et une seule
// sauvegarde partie d'un onglet resté ouvert l'effacerait. Séparée, elle ne
// peut plus être emportée par une écriture du document.
//
// Séparée aussi parce qu'elle est lourde : jusqu'à 8 Mo de PDF. Portée par le
// devis, elle traverserait la liste `GET /api/devis`, qui rend tous les devis
// de l'abonné, et la page recevrait quelques dizaines de mégaoctets pour
// afficher un tableau.
//
// CE QUI ARRIVE N'EST JAMAIS CRU. Ni le type annoncé par la page, ni le poids
// qu'elle déclare : le type est relu dans l'adresse data:, le poids est mesuré
// sur les octets décodés, et le nom de fichier est refabriqué ici.

// Types acceptés. Un devis signé revient au choix numérisé (PDF) ou
// photographié (image matricielle).
//
// image/svg+xml est refusé, et refusé avec son motif propre : un SVG est un
// document, il porte scripts, liens externes et feuilles de style. Cette pièce
// est ensuite servie par une route qui l'ouvre dans un onglet ; accepter un SVG
// reviendrait à exécuter le fichier téléversé sur notre domaine.
export const TYPES_PIECE_ACCEPTES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']

// Plafond posé sur les octets DÉCODÉS, jamais sur la chaîne base64 qui les
// porte (elle pèse un tiers de plus). Six mégaoctets sont atteints par un
// scanner à plat qui rend deux pages en couleur sans réglage ; 8 Mo laissent
// passer ce cas et arrêtent ce qui n'est plus un devis signé.
export const PIECE_OCTETS_MAX = 8 * 1024 * 1024

// Côté long d'une IMAGE après mise au format par la page, avant encodage. Une
// photo de page signée redescend ainsi sous le mégaoctet, largeur de trait et
// signature restant lisibles. Un PDF ne passe pas par là : le navigateur ne
// sait pas le réencoder, il part tel quel, et c'est pour lui que les 8 Mo sont
// réservés.
export const IMAGE_COTE_LONG_MAX = 2000

// Plafond de corps de requête du parseur étroit qui garde le dépôt, dérivé du
// plafond ci-dessus et non écrit à la main : le base64 gonfle de 4/3, et il
// reste l'enveloppe JSON, le nom de fichier et le préfixe de l'adresse data:.
// Le mégaoctet supplémentaire est cette enveloppe. Tenir les deux valeurs
// ensemble évite le pire mode de rupture : un 413 opaque, posé par le parseur
// avant toute garde applicative, là où l'abonné attend le motif rédigé.
export const PIECE_CORPS_LIMITE = `${Math.ceil(PIECE_OCTETS_MAX * 4 / 3 / (1024 * 1024)) + 1}mb`

// L'extension écrite dans le nom de fichier servi vient du type VÉRIFIÉ, jamais
// de celui que portait le nom d'origine.
const EXTENSIONS = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}

// Découpe une adresse data: en type et charge utile. Même expression que
// litLogoDataUrl dans lib/mail-signature.js, et stricte pour la même raison :
// rendre null sur toute forme inattendue plutôt que de deviner.
export function litPieceDataUrl(dataUrl) {
  const s = String(dataUrl || '')
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(s)
  if (!m) return null
  const contentType = m[1].toLowerCase()
  const base64 = m[2]
  if (!TYPES_PIECE_ACCEPTES.includes(contentType)) return null
  let octets
  try {
    octets = Buffer.from(base64, 'base64')
  } catch (e) {
    return null
  }
  if (!octets.length) return null
  return { contentType, base64, octets }
}

// Refus explicites, dans l'ordre où l'abonné peut les rencontrer. Rend null
// quand tout va bien, sinon le motif tel qu'il lui sera lu.
export function motifPieceRefusee(dataUrl) {
  const s = String(dataUrl || '')
  if (/^data:image\/svg\+xml/i.test(s)) {
    return 'Un fichier SVG est un document, pas une image : il n\'est pas accepté comme devis signé. Fournissez un PDF, un PNG, un JPEG ou un WEBP.'
  }
  const lu = litPieceDataUrl(s)
  if (!lu) {
    return 'Ce fichier n\'est pas un document reconnu. Formats acceptés : PDF, PNG, JPEG, WEBP.'
  }
  if (lu.octets.length > PIECE_OCTETS_MAX) {
    const mo = (lu.octets.length / (1024 * 1024)).toFixed(1).replace('.', ',')
    const max = Math.round(PIECE_OCTETS_MAX / (1024 * 1024))
    return `Votre fichier pèse ${mo} Mo, au-delà des ${max} Mo admis. Numérisez en noir et blanc, ou à une définition plus basse.`
  }
  return null
}

// Le nom de fichier est REFABRIQUÉ, jamais repris tel quel. Il finit dans un
// en-tête Content-Disposition : un chemin, un guillemet, un retour à la ligne
// ou un caractère non ASCII y seraient au mieux illisibles, au pire une
// injection d'en-tête. Ne survivent que lettres, chiffres, espace, point,
// tiret et souligné ; l'extension est celle du type vérifié.
//
// Les accents sont décomposés puis leur signe retiré, plutôt que remplacés par
// un tiret comme le reste : « Devis signé » doit rester « Devis signe » et non
// devenir « Devis sign- » dans la fenêtre de téléchargement de l'abonné.
export function nettoieNomFichier(nom, contentType) {
  const ext = EXTENSIONS[contentType] || 'bin'
  const dernierSegment = String(nom || '').split(/[\\/]/).pop()
  const base = dernierSegment
    .replace(/\.[^.]*$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 60)
  return `${base || 'devis-signe'}.${ext}`
}

// Met un enregistrement brut de base à la forme que lit la page : les
// MÉTADONNÉES SEULES, la charge exclue.
//
// C'est l'inverse de signatureEnSortie (lib/mail-signature.js), qui rend le
// logo avec sa charge parce que la page en fait un aperçu. Ici la charge ne
// sert qu'à ouvrir la pièce, ce que fait la route /fichier : la faire voyager
// dans chaque réponse ferait transiter 8 Mo pour afficher « PDF, 6,2 Mo, déposé
// le 3 mars ».
export function pieceEnSortie(rec) {
  if (!rec) return null
  return {
    devisId: rec.devisId || null,
    content_type: rec.content_type || null,
    octets: Number(rec.octets) || 0,
    filename: rec.filename || null,
    deposited_at: rec.deposited_at || null,
    first_deposited_at: rec.first_deposited_at || null
  }
}

export async function chargePiece(db, devisId) {
  const r = await db.query('SELECT * FROM type::record("devis_signature", $id)', { id: String(devisId) })
  return r[0]?.[0] || null
}

// La liste des devis signés d'un abonné, identifiants seuls. Le champ
// contenu_data_url n'est pas nommé dans le SELECT : la liste est appelée à
// chaque ouverture de la page, elle ne doit jamais rapatrier de charge.
export async function listeDevisSignes(db, userId) {
  const r = await db.query('SELECT devisId FROM devis_signature WHERE userId = $userId', { userId: String(userId) })
  return (r[0] || []).map(x => String(x.devisId || '')).filter(Boolean)
}
