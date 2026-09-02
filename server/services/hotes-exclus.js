// Hôtes exclus : la liste noire et son prédicat, module FEUILLE.
//
// POURQUOI UN MODULE À PART. La liste vivait dans recherche-web.js, qui importe
// mentions-legales.js, qui importe referentiel.js. Le filtre d'écriture posé dans
// referentiel.js (enrichReferentielActionnable) aurait donc fermé un cycle
// referentiel -> recherche-web -> mentions-legales -> referentiel. Ce module
// n'importe RIEN, de personne : il peut être lu par n'importe quelle couche sans
// jamais refermer de boucle. recherche-web.js le réexporte, si bien qu'aucun
// appelant historique n'a à changer d'adresse.
//
// Hôtes qui ne peuvent PAS corroborer une entreprise donnée : un candidat, ou un
// website présenté à l'écriture, porté par l'un d'eux est écarté. Suffixe strict sur
// le domaine enregistrable, insensible au www.
//
// Deux familles, même conséquence :
//   . agrégateurs / annuaires / réseaux sociaux / moteurs : la page décrit
//     l'entreprise mais les coordonnées publiées sont celles du portail ;
//   . plateformes de réservation, franchises et enseignes nationales : la page
//     de l'établissement porte le SIRET du réseau, son standard, son courriel
//     générique. Crawler ces domaines ne peut RIEN corroborer sur l'établissement
//     visé, et ne coûte que de la file.
//
// Trois usages, aujourd'hui : le maillon 1.b (filtrerCandidats) écarte les URL
// devinées, le clic Enrichir refuse de lancer le moteur, et le pont par nom d'OSM
// refuse d'écrire. Depuis ce commit, un quatrième : l'entonnoir d'écriture du
// référentiel, qui ferme la porte aux huit sources d'un coup.
export const BLACKLIST_HOSTS = [
  'societe.com', 'pappers.fr', 'pappers.com', 'verif.com', 'kompass.com',
  'pagesjaunes.fr', 'facebook.com', 'instagram.com', 'linkedin.com',
  'google.com', 'google.fr', 'wikipedia.org', 'mappy.com',
  // apparentés fréquents (mêmes familles), écartés par prudence
  'infogreffe.fr', 'manageo.fr', 'bodacc.fr', 'score3.fr', 'dnb.com',
  'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'yelp.fr', 'yelp.com',
  // plateformes de réservation / prise de rendez-vous
  'planity.com', 'doctolib.fr', 'app.kiute.com', 'kalendes.com', 'business.site',
  // coiffure : enseignes et réseaux
  'tchip.fr', 'pascalcoste.com', 'franckprovost.com', 'jeanlouisdavid.com',
  'dessange.com', 'saint-algue.com', 'coiffirst.com', 'davidlucas.fr',
  'labarbieredeparis.com', 'lorealprofessionnel.com',
  // optique : enseignes
  'krys.com', 'optical-center.fr', 'optic2000.com', 'generale-optique.com',
  'monopticien.com', 'opticiensparconviction.fr', 'jimmyfairly.com', 'visual.fr',
  // immobilier : réseaux
  'orpi.com', 'squarehabitat.fr', 'cimm.com', 'msimond.fr',
  'espaces-atypiques.com', 'blot-immobilier.fr', 'lamotte.fr',
  // divers : grande distribution, énergie, franchises
  'carrefour.fr', 'totalenergies.com', 'brunoflaujac.com', 'renoval-veranda.com',
  'diloys.fr', 'laprocure.com', 'methode-busquet.com',
  // annuaires et places de marché relevés par la mesure du 31 août sur dix fiches.
  // infogreffe.fr n'est pas repris ici : il figure déjà plus haut.
  //
  // Les deux premiers sont des SOUS-DOMAINES, et c'est voulu, la convention de la
  // liste étant partout ailleurs le domaine enregistrable : lefigaro.fr et
  // data.gouv.fr doivent rester crawlables, seules leurs sections annuaire sont
  // écartées. hostBlacklisted les prend par égalité stricte et couvre leurs propres
  // sous-domaines, sans jamais toucher au domaine parent.
  'entreprises.lefigaro.fr', 'annuaire-entreprises.data.gouv.fr',
  'contract-factory.com', 'annuaire-france-gratuit.fr', 'leguichetdesformalites.fr',
  'agences-comm.fr', 'societeinfo.com', 'le-site-de.com', 'french-business-law.com'
]

// Hôte inexploitable (vide, illisible) : true, fail-closed. L'appelant qui ne sait
// pas lire l'hôte d'une URL n'a rien à crawler, ni rien à écrire.
export function hostBlacklisted(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase()
  if (!h) return true
  return BLACKLIST_HOSTS.some(b => h === b || h.endsWith('.' + b))
}

// Hôte d'une valeur de champ `website`. Le schéma est souvent absent en base comme
// en saisie ; on le complète POUR PARSER, jamais pour réécrire la valeur. Rend ''
// si illisible, et hostBlacklisted('') vaut true : l'illisible est donc écarté par
// la même porte que la liste noire. Copie exacte de hostDeSite (server.js), remontée
// ici pour que le filtre d'écriture et le clic Enrichir lisent l'hôte à l'identique.
export function hoteDeSite(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).host } catch { return '' }
}

// Réorientation : les seuls hôtes de la liste noire auxquels le référentiel offre
// un champ d'accueil. Une page Facebook est parfois la seule présence en ligne
// d'une TPE ; elle n'a rien à faire dans `website`, où elle occupe une place de
// crawl pour rien, mais tout à faire dans societe_facebook, restitué librement
// (CHAMPS_LIBRES, projection-referentiel.js) et déjà affiché par le front.
//
// Les autres hôtes n'ont PAS de champ d'accueil, et c'est un arbitrage, pas un
// oubli : planity, tchip, business.site ou orpi décrivent un réseau, pas
// l'établissement. Ils sont écartés sans être conservés nulle part. Aucun champ
// nouveau n'est créé pour eux.
//
// Clés = entrées de BLACKLIST_HOSTS, donc la correspondance par suffixe de
// champReseauPourHote couvre m.facebook.com, fr-fr.facebook.com, fr.linkedin.com.
const CHAMP_RESEAU = {
  'facebook.com': 'societe_facebook',
  'instagram.com': 'societe_instagram',
  'linkedin.com': 'societe_linkedin'
}

// Champ de réseau social correspondant à un hôte, ou '' s'il n'y en a pas.
// MÊME correspondance que hostBlacklisted (égalité ou suffixe, www retiré,
// insensible à la casse) : un hôte réorienté est nécessairement un hôte écarté.
export function champReseauPourHote(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase()
  if (!h) return ''
  for (const [b, champ] of Object.entries(CHAMP_RESEAU)) {
    if (h === b || h.endsWith('.' + b)) return champ
  }
  return ''
}
