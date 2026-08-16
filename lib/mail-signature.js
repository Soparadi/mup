// ── Signature d'abonné ────────────────────────────────────────────────────
// Table dédiée `mail_signature`, un enregistrement par abonné, id = userId.
//
// POURQUOI UNE TABLE À ELLE, et non les colonnes signature_html /
// signature_text qui dorment dans mail_settings depuis la session 1 :
// mail_settings porte la configuration IMAP — hôte, utilisateur, mot de passe
// chiffré. Les écritures qui la visent la remplacent en entier (upsertRecord
// fait UPDATE … CONTENT, pas MERGE) et sa suppression est totale. Enregistrer
// une signature là écraserait le mot de passe de la boîte, et « supprimer ma
// signature » la débrancherait. Séparées, les deux vies ne peuvent plus se
// marcher dessus par construction.
//
// CE QUE L'ABONNÉ SAISIT EST DU TEXTE. Le balisage est construit ici, à partir
// de son texte et de sa disposition. Un champ libre rendu tel quel injecterait
// du HTML arbitraire dans chaque message qu'il envoie — et le destinataire le
// recevrait signé de son nom.

// L'identifiant de contenu qui relie le src="cid:…" du HTML à la pièce en
// ligne. Sans chevrons : chaque transport pose les siens à sa façon.
export const LOGO_CID = 'mup-signature-logo'
export const LOGO_FILENAME = 'signature-logo.png'

// Types matriciels seulement. image/svg+xml est refusé : un SVG est un
// document — il porte scripts, liens externes et feuilles de style — et non
// une image. Le rendre dans la prévisualisation ou dans un client mail
// reviendrait à exécuter le fichier téléversé.
export const TYPES_LOGO_ACCEPTES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

// Plafond posé APRÈS mise au format côté page. À 320 × 160 pixels, un logo
// dépasse rarement 60 Ko ; 300 Ko laisse passer les images bruitées et arrête
// ce qui n'est pas un logo.
export const LOGO_OCTETS_MAX = 300 * 1024

// Bornes de la mise au format. Le logo est encodé au double de sa taille
// d'affichage pour rester net sur écran dense : 320 px encodés s'affichent à
// 160 px. Ces deux constantes sont reprises telles quelles par la page.
export const LOGO_LARGEUR_ENCODEE_MAX = 320
export const LOGO_HAUTEUR_ENCODEE_MAX = 160
const FACTEUR_DENSITE = 2

export const TEXTE_LONGUEUR_MAX = 2000

export const DISPOSITIONS = ['dessus', 'cote']

function echappeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Le texte saisi devient du HTML par deux gestes et pas un de plus : tout
// caractère qui compte en HTML est neutralisé, puis les retours à la ligne
// deviennent des <br>. Rien d'autre n'est interprété — ni balise, ni entité,
// ni attribut. C'est la seule porte par laquelle le texte de l'abonné entre
// dans le balisage.
function texteEnHtml(texte) {
  return echappeHtml(texte).replace(/\r\n|\r|\n/g, '<br>')
}

const STYLE_TEXTE = 'font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#333333;'
const STYLE_IMG = 'height:auto;border:0;outline:none;text-decoration:none;display:block;'

// Le logo est encodé au double de sa taille d'affichage : la largeur écrite
// dans le balisage est la moitié de la largeur encodée. Sans dimensions
// connues, on retombe sur un plafond en style, qui préserve les proportions
// sans les connaître.
function baliseLogo(source, largeurEncodee, hauteurEncodee) {
  const l = Number(largeurEncodee)
  const h = Number(hauteurEncodee)
  if (Number.isFinite(l) && l > 0 && Number.isFinite(h) && h > 0) {
    const largeur = Math.max(1, Math.round(l / FACTEUR_DENSITE))
    const hauteur = Math.max(1, Math.round(h / FACTEUR_DENSITE))
    return `<img src="${echappeHtml(source)}" alt="" width="${largeur}" height="${hauteur}" style="width:${largeur}px;height:${hauteur}px;${STYLE_IMG}">`
  }
  const lMax = Math.round(LOGO_LARGEUR_ENCODEE_MAX / FACTEUR_DENSITE)
  const hMax = Math.round(LOGO_HAUTEUR_ENCODEE_MAX / FACTEUR_DENSITE)
  return `<img src="${echappeHtml(source)}" alt="" style="max-width:${lMax}px;max-height:${hMax}px;${STYLE_IMG}">`
}

// Construit le balisage de la signature. `logoSrc` vaut "cid:…" pour un envoi
// et une adresse data: pour la prévisualisation — c'est la seule différence
// entre ce que l'abonné voit avant de retenir et ce qui part ensuite.
//
// La disposition « côte à côte » passe par un tableau et non par flex ou
// float : les clients mail de bureau ne rendent pas la mise en page moderne,
// et deux cellules d'un tableau tiennent partout.
//
// JUMEAU — construitSignatureHtmlPage(), dans public/mail.html, rend le même
// balisage pour l'aperçu. La page tourne dans le navigateur et ne peut pas
// importer ce module ; l'aperçu doit montrer le rendu AVANT enregistrement,
// donc avant que le serveur ait quoi que ce soit à construire. Toute
// modification ici doit être portée là-bas dans la même passe, faute de quoi
// l'abonné retient une signature d'après un aperçu qui n'est plus le sien.
export function construitSignatureHtml({ texte, disposition, logoSrc, logo_width, logo_height }) {
  const corps = texteEnHtml(texte || '')
  const img = logoSrc ? baliseLogo(logoSrc, logo_width, logo_height) : ''
  if (!img) {
    return `<div style="${STYLE_TEXTE}">${corps}</div>`
  }
  if (disposition === 'cote') {
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">'
      + '<tr>'
      + `<td style="padding:0 14px 0 0;vertical-align:top;">${img}</td>`
      + `<td style="padding:0;vertical-align:top;${STYLE_TEXTE}">${corps}</td>`
      + '</tr></table>'
  }
  return `<div><div style="margin:0 0 10px 0;">${img}</div><div style="${STYLE_TEXTE}">${corps}</div></div>`
}

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

// Met un enregistrement brut de base à la forme que lisent la page et l'envoi.
// Les secrets n'existent pas ici : tout ce que porte la table est destiné à
// partir dans les messages de l'abonné.
export function signatureEnSortie(rec) {
  if (!rec) return null
  return {
    active: Boolean(rec.active),
    texte: String(rec.texte || ''),
    disposition: DISPOSITIONS.includes(rec.disposition) ? rec.disposition : 'dessus',
    logo_data_url: rec.logo_data_url || null,
    logo_width: Number(rec.logo_width) || null,
    logo_height: Number(rec.logo_height) || null,
    updated_at: rec.updated_at || null
  }
}

export async function chargeSignature(db, userId) {
  const r = await db.query('SELECT * FROM type::record("mail_signature", $id)', { id: String(userId) })
  return r[0]?.[0] || null
}

// La pièce en ligne : contenu en base64, type, identifiant de contenu, et le
// drapeau qui dit que ce n'est pas une pièce jointe à télécharger. Cette forme
// se veut neutre, mais à ce commit aucun des quatre transports ne sait encore
// la traduire — leur apprendre est l'objet de la passe suivante.
function pieceLogo(lu) {
  return {
    filename: LOGO_FILENAME,
    content: lu.base64,
    contentType: lu.contentType,
    cid: LOGO_CID,
    inline: true
  }
}

// Apposera la signature en fin de message, côté serveur, juste avant que le
// transport prenne la main. À ce commit, cette fonction n'est appelée par
// personne : l'envoi ne l'importe pas, et rien de ce fichier ne change le
// trajet d'un message qui part. Le branchement est la dernière passe du
// chantier.
//
// Elle sera le seul endroit où la signature s'ajoute, pour qu'aucune des
// quatre voies d'envoi n'ait à la connaître et que rien ne soit collé dans le
// champ de rédaction de l'abonné.
//
// Le repli texte est conservé : un message part avec sa partie texte ET sa
// partie HTML. La version texte de la signature est le texte saisi, sans le
// logo — un client qui n'affiche pas le HTML lit la signature quand même.
export async function apposeSignature(db, userId, { body, html, attachments }) {
  const rec = await chargeSignature(db, userId)
  const sig = signatureEnSortie(rec)
  if (!sig || !sig.active) return { body, html, attachments }
  const lu = sig.logo_data_url ? litLogoDataUrl(sig.logo_data_url) : null
  const logoValide = lu && lu.octets.length <= LOGO_OCTETS_MAX
  if (!sig.texte.trim() && !logoValide) return { body, html, attachments }

  const signatureHtml = construitSignatureHtml({
    texte: sig.texte,
    disposition: sig.disposition,
    logoSrc: logoValide ? `cid:${LOGO_CID}` : null,
    logo_width: sig.logo_width,
    logo_height: sig.logo_height
  })

  // Une partie HTML est produite même quand l'abonné n'a écrit que du texte :
  // sans elle le logo n'aurait nulle part où s'afficher. Le corps saisi y est
  // repris échappé, ses retours à la ligne préservés — comme la signature.
  const corpsHtml = html || (body ? `<div style="${STYLE_TEXTE}">${texteEnHtml(body)}</div>` : '')
  const nouveauHtml = corpsHtml
    ? `${corpsHtml}<br><br>${signatureHtml}`
    : signatureHtml
  const nouveauTexte = sig.texte.trim()
    ? `${body || ''}\n\n${sig.texte}`
    : (body || '')

  const pieces = Array.isArray(attachments) ? attachments.slice() : []
  if (logoValide) pieces.push(pieceLogo(lu))

  return { body: nouveauTexte, html: nouveauHtml, attachments: pieces.length ? pieces : undefined }
}
