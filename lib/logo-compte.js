// ── Logo du compte, en tête des devis ─────────────────────────────────────
// Table dédiée `account_logo`, un enregistrement par abonné, id = userId.
//
// POURQUOI UNE TABLE À ELLE, et non une clé de plus dans user_settings :
// user_settings est écrite par TROIS pages (Frais, Statistiques et l'encart
// de Devis) dont deux renvoient leur objet ENTIER en PUT. Une image de
// plusieurs centaines de kilooctets y voyagerait à chaque enregistrement de
// n'importe quel réglage, et un onglet resté ouvert sur Frais l'effacerait en
// reposant ses vieilles valeurs. Séparé, le logo ne peut plus être emporté par
// une écriture qui ne le vise pas.
//
// POURQUOI PAS lib/mail-signature.js, dont ce fichier reprend le patron à la
// lettre : ce module-là construit AUSSI le balisage d'un courriel, et surtout
// ses bornes sont celles d'une signature de message, 320 × 160 pixels pour un
// affichage écran. Celles d'ici se déduisent d'une taille sur le PAPIER. Les
// fondre en un module paramétré ferait dépendre le trajet des courriels d'une
// passe sur les devis ; deux modules qui se ressemblent valent mieux qu'un
// module qui sert deux maîtres.

// Types matriciels seulement. image/svg+xml est refusé : un SVG est un
// document (il porte scripts, liens externes et feuilles de style) et non
// une image. Le rendre dans l'aperçu du devis reviendrait à exécuter le
// fichier téléversé.
export const TYPES_LOGO_ACCEPTES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

// ── LES BORNES, ET D'OÙ ELLES VIENNENT ────────────────────────────────────
// La taille SUR LA FEUILLE est l'arbitrage : 60 mm de large au maximum, et en
// hauteur ce que mesure le bloc de droite de la tête de feuille, dont le logo
// prend désormais le plafond. Ce bloc a une hauteur ARRÊTÉE, celle de ses
// quatre lignes au complet, que public/devis.html dérive de la somme de leurs
// corps et de leurs marges :
//     (5,82 + 3,18 + 2,91 + 2,91) mm × 1,28 + 0,79 + 0,26 + 0,26 mm = 20,28 mm
// Proportions préservées, l'image n'étant jamais agrandie au-delà de sa taille
// naturelle. Les bornes d'ENCODAGE s'en déduisent à 300 points par pouce, la
// définition d'une impression de bureau :
//     60,00 mm ÷ 25,4 × 300 = 708,66  → 709 px
//     20,28 mm ÷ 25,4 × 300 = 239,52  → 240 px
// Au-delà, les pixels encodés ne sortiraient pas de l'imprimante : ils ne
// pèseraient que dans la base et dans l'aperçu.
export const LOGO_LARGEUR_ENCODEE_MAX = 709
export const LOGO_HAUTEUR_ENCODEE_MAX = 240

// LE PLAFOND EN OCTETS SE RECALCULE SUR CES DIMENSIONS. Celui du courriel,
// 300 Ko, est mort sous 320 × 160 : le reprendre tel quel refuserait ici des
// logos parfaitement ordinaires, puisque la toile encode deux fois et demie
// plus de pixels.
//     709 × 177 = 125 493 pixels
//     320 × 160 =  51 200 pixels
//     rapport   = 2,451
//     300 Ko × 2,451 = 735 Ko, arrondis à 750 Ko.
// Le plafond garde donc exactement la générosité du courriel, rapportée à la
// surface : il laisse passer les images bruitées et arrête ce qui n'est pas un
// logo. En adresse data:, 750 Ko encodés font environ 1 Mo transmis, et le
// parseur global de 10 Mo (server.js) les porte sans qu'on lui pose de limite
// propre.
export const LOGO_OCTETS_MAX = 750 * 1024

// Découpe une adresse data: en type et charge utile. Rend null sur toute forme
// inattendue plutôt que de deviner : le serveur ne fait confiance ni au type
// annoncé par la page, ni à ce que la page prétend avoir encodé.
export function litLogoDataUrl(dataUrl) {
  const s = String(dataUrl || '')
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(s)
  if (!m) return null
  const contentType = m[1].toLowerCase()
  const base64 = m[2]
  if (!TYPES_LOGO_ACCEPTES.includes(contentType)) return null
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
export function motifLogoRefuse(dataUrl) {
  const s = String(dataUrl || '')
  if (/^data:image\/svg\+xml/i.test(s)) {
    return 'Un fichier SVG est un document, pas une image : il n\'est pas accepté comme logo. Fournissez un PNG, un JPEG, un WEBP ou un GIF.'
  }
  const lu = litLogoDataUrl(s)
  if (!lu) {
    return 'Ce fichier n\'est pas une image reconnue. Formats acceptés : PNG, JPEG, WEBP, GIF.'
  }
  if (lu.octets.length > LOGO_OCTETS_MAX) {
    const ko = Math.round(lu.octets.length / 1024)
    const max = Math.round(LOGO_OCTETS_MAX / 1024)
    return `Votre logo pèse ${ko} Ko après mise au format, au-delà des ${max} Ko admis. Choisissez une image moins détaillée.`
  }
  return null
}

// Met un enregistrement brut de base à la forme que lit la page. Aucun secret
// ici : ce que porte la table est destiné à s'imprimer en tête des devis de
// l'abonné.
export function logoEnSortie(rec) {
  if (!rec) return null
  return {
    logo_data_url: rec.logo_data_url || null,
    logo_width: Number(rec.logo_width) || null,
    logo_height: Number(rec.logo_height) || null,
    updated_at: rec.updated_at || null
  }
}

export async function chargeLogoCompte(db, userId) {
  const r = await db.query('SELECT * FROM type::record("account_logo", $id)', { id: String(userId) })
  return r[0]?.[0] || null
}
