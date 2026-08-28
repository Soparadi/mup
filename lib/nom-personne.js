// Composition unifiée du NOM D'UNE PERSONNE. Source de vérité côté serveur ;
// le jumeau navigateur est public/js/nom-personne.js, à garder synchronisé.
//
// Une personne du CRM porte son identité en DEUX CASES qui font autorité,
// `prenom` et `nom_personne`, plus une troisième case à part, `civilite`. La
// chaîne `contact_nom` (« Prénom Nom » d'un seul tenant) est un champ ancien :
// elle reste alimentée pour la compatibilité, elle se DÉRIVE des deux cases, et
// elle ne les commande jamais.
//
// RAPPEL DU PIÈGE DE NOMMAGE, que ce module ne touche pas : sur un record
// `contacts`, `nom` est la RAISON SOCIALE de la société, jamais le patronyme.
// Le patronyme, c'est `nom_personne`. Voir lib/person-fields.js.
//
// Quatre fonctions, et TOUTES LES SURFACES LISENT CELLES-CI, aucune n'en réécrit
// de variante : decouperNomComplet découpe une chaîne, casesNomPersonne rend les
// deux cases d'un enregistrement (découpe sous garde comprise), nomPersonne rend
// la ligne à afficher, composerNomComplet rend la chaîne à écrire.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QUI SÉPARE CE MODULE DE SON MODÈLE, ET IL FAUT LE DIRE D'ABORD.
//
// Le lot d'adresse a posé la même mécanique à trois cases : découper, amorcer
// sous garde, composer. Elle repose là-bas sur une ANCRE VÉRIFIABLE, le dernier
// bloc de cinq chiffres de la chaîne. Un code postal se reconnaît.
//
// UN NOM DE PERSONNE N'A PAS D'ANCRE. Ni forme, ni position, ni longueur. La
// règle positionnelle ci-dessous (premier mot = prénom, tout le reste = nom) est
// une CONJECTURE, pas une lecture. Elle rend « Jean Dupont » et « Jean de La
// Fontaine » ; elle se trompe sur « Jean Pierre Dupont » (prénom composé sans
// trait d'union), sur « DUPONT Jean » (format annuaire, inversé), sur
// « Dupont, Jean » (la virgule n'est pas lue), et elle fabrique un prénom sur
// « Service commercial ».
//
// CONSÉQUENCE, ET C'EST LA RÈGLE DU LOT : LA DÉCOUPE N'ÉCRIT JAMAIS D'ELLE-MÊME.
// recomposerAdresseAgregee accepte de partir de la découpe d'un agrégat parce
// que cette découpe est vérifiable. Ici, non. Une chaîne ancienne est découpée
// À LA LECTURE, pour AMORCER les deux cases d'un écran éditable, et elle n'est
// écrite que si l'abonné touche l'une des deux cases de nom. On n'écrit que ce
// que l'on corrige. Ce module est pur : il ne pose rien sur l'enregistrement
// qu'on lui passe, et c'est à l'appelant de tenir cette règle.
// ─────────────────────────────────────────────────────────────────────────────

const texte = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()))

// Civilité de tête détachée d'une chaîne : « M. Jean Dupont » rend
// { civilite: 'M.', reste: 'Jean Dupont' }. Mme/Madame/Mlle/Mademoiselle rendent
// « Mme », M./Mr/Monsieur rendent « M. », ce sont les deux seules valeurs que le
// sélecteur de la fiche société propose. Rien reconnu, civilité vide et chaîne
// intacte. Règle reprise à la lettre d'extraireCivilite (lib/import.js), qui
// l'applique déjà aux colonnes d'un fichier importé.
const CIVILITE = /^\s*(mme|madame|mlle|mademoiselle|monsieur|mr|m)\.?\s+/i

export function detacherCivilite(chaine) {
  const s = texte(chaine)
  const m = s.match(CIVILITE)
  if (!m) return { civilite: '', reste: s }
  const t = m[1].toLowerCase()
  const civilite = (t === 'mme' || t === 'madame' || t === 'mlle' || t === 'mademoiselle') ? 'Mme' : 'M.'
  return { civilite, reste: s.slice(m[0].length).trim() }
}

// Découpe une chaîne « Prénom Nom » en ses deux cases, civilité de tête détachée
// au passage.
//
// LA RÈGLE EST POSITIONNELLE, et c'est la seule que le produit connaisse déjà :
// le PREMIER mot est le prénom, TOUT LE RESTE est le nom. C'est mot pour mot
// personnesDeLigne et decouperDirigeants (lib/import.js), qui découpent les
// colonnes d'un fichier importé depuis toujours. Une seule règle, deux emplois.
//
// Ce que la position sait faire : le trait d'union tient un prénom composé en un
// seul mot (« Jean-Pierre Dupont »), et une particule reste au nom puisque tout
// ce qui suit le premier mot y va (« Jean de La Fontaine », « Marie Le Goff »).
//
// UN SEUL MOT VA AU NOM, prénom vide. C'est le choix de decouperDirigeants, et
// il vaut mieux que l'inverse : dans un CRM, un mot unique est plus souvent un
// patronyme qu'un prénom, et une case vide se voit alors qu'une case fausse ne
// se voit pas.
//
// RIEN N'EST FABRIQUÉ. Chaîne vide, ou réduite à une civilité, les deux cases
// sortent vides : aucune valeur n'est inventée, comme la ville facultative de la
// découpe d'adresse.
export function decouperNomComplet(chaine) {
  const { civilite, reste } = detacherCivilite(chaine)
  if (!reste) return { civilite, prenom: '', nom_personne: '' }
  const mots = reste.split(/\s+/).filter(Boolean)
  if (mots.length === 1) return { civilite, prenom: '', nom_personne: mots[0] }
  return { civilite, prenom: mots[0], nom_personne: mots.slice(1).join(' ') }
}

// ── LES DEUX CASES D'UN ENREGISTREMENT, TELLES QU'IL FAUT LES LIRE ──
//
// Une fiche porte son identité de personne en deux cases, `prenom` et
// `nom_personne`. Les enregistrements anciens ne portent que la chaîne
// `contact_nom` : leurs cases se tirent de sa découpe.
//
// LA GARDE EST STRICTE : la découpe ne joue QUE si les DEUX cases de nom sont
// vides. Un enregistrement portant déjà un prénom ou un nom n'est JAMAIS
// redécoupé, sans quoi une correction manuelle serait écrasée par une
// déduction. C'est mot pour mot la garde de casesAdresse.
//
// LA CIVILITÉ N'ENTRE PAS DANS LA GARDE, et c'est voulu. Elle est une case à
// part, comme le SIRET à côté de l'adresse : une fiche qui porte « Mme » et rien
// d'autre doit voir ses deux cases de nom s'amorcer. Et la civilité DÉJÀ POSÉE
// l'emporte sur celle que la découpe détache : une case renseignée n'est jamais
// recouverte par une déduction, dans ce sens-là non plus.
//
// LECTURE PURE : rien n'est posé sur l'enregistrement. Ce qui n'est pas corrigé
// n'est pas écrit, et une déduction ne devient pas une saisie.
export function casesNomPersonne(rec) {
  const r = rec || {}
  const civilite = texte(r.civilite)
  const prenom = texte(r.prenom)
  const nom = texte(r.nom_personne)
  if (prenom || nom) return { civilite, prenom, nom_personne: nom }
  const chaine = texte(r.contact_nom)
  if (!chaine) return { civilite, prenom: '', nom_personne: '' }
  const d = decouperNomComplet(chaine)
  return { civilite: civilite || d.civilite, prenom: d.prenom, nom_personne: d.nom_personne }
}

// ── LA LIGNE DE NOM, UNE SEULE COMPOSITION POUR TOUTES LES SURFACES ──
//
// Les deux cases jointes dans l'ordre d'usage, les vides sautées. C'est ce qu'un
// écran affiche, ce qu'un document imprime, ce qu'une liste cherche.
//
// LA CIVILITÉ N'Y EST PAS. Elle est une case à part et le reste : la ligne
// composée est « Jean Dupont », jamais « M. Jean Dupont ». Une surface qui veut
// la civilité la préfixe elle-même, comme l'écran de validation d'import le fait
// déjà. Sans cette règle, la civilité entrerait dans la recherche, dans le
// rapprochement et sur la ligne destinataire d'un devis, trois endroits où elle
// n'a rien à faire.
//
// AUCUN REPLI SUR LA CHAÎNE, ET C'EST LA DIFFÉRENCE AVEC adresseComposee. Là-bas
// l'agrégat reste maître sans voie connue, parce que la découpe postale ÉCARTE
// ce qu'elle ne reconnaît pas : une voie peut ne vivre que dans l'agrégat, et
// composer la perdrait. Ici la découpe PARTITIONNE : tout mot de la chaîne
// atterrit dans l'une des deux cases, sans exception. Recomposer une chaîne
// amorcée rend donc la chaîne elle-même, aux espaces multiples près, et la seule
// chose qui n'y revient pas est la civilité de tête, qui a rejoint sa propre
// case. Un repli serait du code que rien ne peut atteindre.
export function nomPersonne(rec) {
  const c = casesNomPersonne(rec)
  return [c.prenom, c.nom_personne].filter(Boolean).join(' ')
}

// ── LA CHAÎNE À ÉCRIRE, DÉRIVÉE DES DEUX CASES ──
//
// Le jumeau en écriture de nomPersonne : la MÊME composition, pour la poser sur
// `contact_nom`. Une seule règle, deux emplois : là, on lit, ici, on écrit.
//
// ELLE SE VIDE. Les deux cases vidées rendent la chaîne vide, et c'est tout
// l'objet de cette fonction. La recomposition de la fiche société protégeait
// jusqu'ici l'ancienne valeur par un `||`, si bien qu'un nom effacé restait
// trouvable par la recherche après avoir disparu de l'écran. Une case vidée est
// un geste, pas une absence : c'est la distinction que le MERGE porte déjà
// jusqu'en base.
//
// AUCUNE DÉCOUPE ICI, et c'est la différence avec casesNomPersonne : on compose
// à partir des deux cases TELLES QU'ELLES SONT, jamais de la découpe de
// l'ancienne chaîne. Une déduction n'a pas à s'écrire au passage d'une écriture
// qui ne la vise pas.
export function composerNomComplet(cases) {
  const c = cases || {}
  return [texte(c.prenom), texte(c.nom_personne)].filter(Boolean).join(' ')
}
