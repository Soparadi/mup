// ── Authentification du domaine de la boîte connectée ─────────────────────
// Un abonné qui prospecte depuis sa propre adresse — contact@son-domaine.fr —
// ne saura jamais que ses messages tombent en indésirables : personne ne se
// plaint, personne ne signale, il n'y a que du silence au bout de ses envois.
// Ce module va lire la zone DNS de son domaine et dit ce qui manque pour que
// ses messages soient reconnus comme venant de lui.
//
// POURQUOI UN MODULE À LUI. Le serveur n'interroge le DNS nulle part ailleurs.
// Tout ce qui touche à la résolution — les délais de garde, le cache, la
// distinction entre « pas d'enregistrement » et « pas de réponse » — tient
// ici, et rien de tout cela ne remonte dans les routes. Aucune dépendance
// nouvelle : node:dns/promises fait le travail.
//
// CE QUE ÇA N'EST PAS. La vérification de domaine des campagnes interroge
// Resend, qui rend l'état des enregistrements QU'IL A LUI-MÊME dictés. Ici on
// lit la zone réelle, pour une boîte que MovUP n'a jamais configurée. Les deux
// mécaniques ne se ressemblent que de loin : ne pas les confondre.
//
// LE VERDICT NE PROMET JAMAIS L'INVERSE. Des enregistrements en place ne
// garantissent pas la boîte de réception — le contenu, la réputation de
// l'expéditeur et l'humeur du filtre comptent tout autant. Tout ce qu'on peut
// dire, et tout ce qu'on dit, c'est que rien ne bloque DE CE CÔTÉ.

import { Resolver } from 'node:dns/promises'

// ── Domaines grand public ─────────────────────────────────────────────────
// Une adresse chez un webmail grand public n'a RIEN à configurer : la zone
// appartient au fournisseur, l'abonné n'y a aucun accès, et SPF comme DKIM y
// sont en place depuis toujours. Lui annoncer un réglage à faire lui
// inventerait un problème qu'il ne peut pas résoudre et qu'il n'a pas.
//
// POURQUOI PAS DOMAINES_PERSO de lib/import.js. Cette liste-là sert à trancher
// « e-mail professionnel ou personnel » pour décider de créer une société à
// l'import : la classer trop court y produit une société de trop, ce qui se
// corrige d'un geste. Ici une omission produit une alarme mensongère sur la
// boîte de l'abonné. Les deux listes n'ont ni le même usage ni le même coût
// d'erreur — les fusionner ferait qu'un ajout motivé par l'un dégraderait
// l'autre en silence.
//
// GÉNÉREUSE À DESSEIN. Dans le doute, s'abstenir : un domaine de trop dans
// cette liste, c'est un contrôle qu'on ne fait pas ; un domaine qui y manque,
// c'est un abonné qu'on alarme pour rien. Le second est bien plus coûteux.
export const DOMAINES_GRAND_PUBLIC = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'outlook.com', 'outlook.fr', 'outlook.be', 'outlook.de', 'outlook.es',
  'outlook.it', 'outlook.pt', 'outlook.co.uk', 'outlook.ie',
  'hotmail.com', 'hotmail.fr', 'hotmail.be', 'hotmail.de', 'hotmail.es',
  'hotmail.it', 'hotmail.co.uk', 'hotmail.ca', 'hotmail.nl',
  'live.com', 'live.fr', 'live.be', 'live.co.uk', 'live.nl', 'live.ca',
  'live.de', 'live.it', 'msn.com', 'windowslive.com',
  // Yahoo
  'yahoo.com', 'yahoo.fr', 'yahoo.co.uk', 'yahoo.de', 'yahoo.es', 'yahoo.it',
  'yahoo.ca', 'yahoo.com.br', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // AOL
  'aol.com', 'aol.fr', 'aim.com',
  // Boîtes chiffrées / indépendantes
  'protonmail.com', 'protonmail.ch', 'proton.me', 'pm.me',
  'tutanota.com', 'tutanota.de', 'tuta.io', 'tuta.com',
  'fastmail.com', 'fastmail.fm', 'hushmail.com',
  'zoho.com', 'zohomail.com', 'mailfence.com', 'posteo.de', 'mailbox.org',
  // GMX / 1&1 / mail.com
  'gmx.com', 'gmx.fr', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch',
  'web.de', 'mail.com', 'email.com',
  // Yandex / mail.ru
  'yandex.com', 'yandex.ru', 'ya.ru',
  'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru',
  // Fournisseurs d'accès — France
  'free.fr', 'aliceadsl.fr', 'orange.fr', 'wanadoo.fr', 'sfr.fr', 'neuf.fr',
  'cegetel.net', 'club-internet.fr', 'numericable.fr', 'noos.fr', 'bbox.fr',
  'bouyguestelecom.fr', 'laposte.net', 'voila.fr', 'infonie.fr', 'tele2.fr',
  '9online.fr', 'dbmail.com', 'netcourrier.com', 'caramail.com', 'lycos.fr',
  // Fournisseurs d'accès — Belgique, Suisse, Luxembourg, Canada
  'skynet.be', 'proximus.be', 'telenet.be', 'voo.be', 'belgacom.net',
  'bluewin.ch', 'sunrise.ch', 'hispeed.ch', 'bluemail.ch',
  'pt.lu', 'internet.lu',
  'videotron.ca', 'sympatico.ca', 'bell.net', 'shaw.ca', 'telus.net',
  // Fournisseurs d'accès — Royaume-Uni, États-Unis
  'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net',
  'ntlworld.com', 'blueyonder.co.uk', 'tiscali.co.uk',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net',
  'charter.net', 'bellsouth.net', 'earthlink.net', 'juno.com',
  'optonline.net', 'roadrunner.com', 'rr.com',
  // Europe continentale
  't-online.de', 'freenet.de', 'arcor.de',
  'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'tin.it',
  'terra.es', 'telefonica.net', 'wanadoo.es',
  'sapo.pt', 'planet.nl', 'ziggo.nl', 'kpnmail.nl', 'home.nl', 'chello.nl',
  'telia.com', 'seznam.cz', 'wp.pl', 'onet.pl', 'o2.pl', 'interia.pl',
  // Asie
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com',
  'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com',
  // Adresses jetables — une boîte de prospection n'en est jamais une, mais un
  // contrôle sur ces domaines-là n'aurait aucun sens non plus.
  'yopmail.com', 'mailinator.com', 'jetable.org', 'guerrillamail.com',
  'trashmail.com', '10minutemail.com'
])

export function estDomaineGrandPublic(domaine) {
  return DOMAINES_GRAND_PUBLIC.has(String(domaine || '').trim().toLowerCase())
}

// ── Fournisseurs connus ───────────────────────────────────────────────────
// On ne vérifie pas QU'UN SPF EXISTE : on vérifie que LE FOURNISSEUR DE CETTE
// BOÎTE y figure. La nuance est tout le sujet — un domaine relevé porte un
// SPF hérité d'un ancien hébergeur ou du formulaire de contact du site, qui
// autorise quelqu'un d'autre. Un contrôle naïf l'aurait déclaré en règle,
// pendant que chaque message de l'abonné échoue à l'authentification.
//
// `spf` est le jeton canonique, celui qu'on fera demander à l'abonné.
// `famillesSpf` est ce qu'on ACCEPTE en le lisant, et c'est un piège de plus :
// le jeton canonique n'est lui-même qu'une enveloppe autour des plages
// d'adresses du fournisseur, et une zone peut parfaitement inclure ces plages
// directement — github.com autorise Google par include:_netblocks.google.com
// et include:_netblocks2.google.com, sans jamais nommer _spf.google.com. Exiger
// le jeton exact aurait déclaré manquante une autorisation bel et bien en
// place. Tout include: qui relève du fournisseur compte donc, quelle que soit
// la porte par laquelle il passe.
//
// `selecteurs` sont les noms sous lesquels chercher la clé DKIM ; le premier
// est celui du fournisseur, les suivants sont les usages courants — un
// administrateur peut avoir choisi son propre préfixe, et ne pas les essayer
// produirait un « DKIM manquant » faux.
const FOURNISSEURS = {
  google: {
    cle: 'google',
    nom: 'Google Workspace',
    spf: '_spf.google.com',
    famillesSpf: [/(^|\.)google\.com$/, /(^|\.)googlemail\.com$/],
    selecteurs: ['google', 'default', 'dkim', 's1', 'k1', 'mail'],
    // Ce que l'abonné doit demander, en une phrase transmissible telle quelle.
    // Chaque morceau commence par un VERBE À L'INFINITIF : ils s'enchaînent
    // derrière un « Pourriez-vous, dans la zone DNS du domaine X, … », seuls ou
    // à deux, et un morceau qui commencerait par un nom y ferait une phrase
    // bancale sous les yeux du technicien.
    demandeDkim: (d) => `publier l'enregistrement TXT nommé google._domainkey.${d}, avec la clé DKIM générée depuis la console d'administration Google Workspace (rubrique Gmail, « Authentifier les e-mails »)`
  },
  microsoft: {
    cle: 'microsoft',
    nom: 'Microsoft 365',
    spf: 'spf.protection.outlook.com',
    famillesSpf: [/(^|\.)outlook\.com$/, /(^|\.)microsoft\.com$/, /(^|\.)office365\.com$/, /(^|\.)hotmail\.com$/],
    selecteurs: ['selector1', 'selector2', 'default', 'dkim', 's1', 'k1'],
    demandeDkim: (d) => `publier les deux enregistrements CNAME nommés selector1._domainkey.${d} et selector2._domainkey.${d}, avec les valeurs indiquées dans le centre d'administration Microsoft 365, puis activer la signature DKIM pour ce domaine`
  }
}

// Une boîte connectée en manuel ne dit pas son fournisseur : elle dit un hôte
// SMTP. Quand cet hôte est reconnu, le contrôle complet s'applique. Sinon on
// ne devine pas — un include: inventé pour un hébergeur qu'on croit reconnaître
// enverrait l'abonné demander une ligne dont il n'a pas besoin. Il reste alors
// le seul constat qui ne dépende d'aucun fournisseur : l'absence totale de SPF.
const HOTES_SMTP_CONNUS = [
  { motif: /(^|\.)smtp\.gmail\.com$/i, cle: 'google' },
  { motif: /(^|\.)aspmx\.l\.google\.com$/i, cle: 'google' },
  { motif: /(^|\.)smtp-relay\.gmail\.com$/i, cle: 'google' },
  { motif: /(^|\.)smtp\.office365\.com$/i, cle: 'microsoft' },
  { motif: /(^|\.)smtp\.outlook\.com$/i, cle: 'microsoft' },
  { motif: /(^|\.)smtp\.exchangelabs\.com$/i, cle: 'microsoft' }
]

function fournisseurDepuisHoteSmtp(hote) {
  const h = String(hote || '').trim().toLowerCase().replace(/\.$/, '')
  if (!h) return null
  const trouve = HOTES_SMTP_CONNUS.find(x => x.motif.test(h))
  return trouve ? FOURNISSEURS[trouve.cle] : null
}

function fournisseurDepuisCle(cle) {
  return FOURNISSEURS[String(cle || '').toLowerCase()] || null
}

// ── Résolution ────────────────────────────────────────────────────────────
// DÉLAI DE GARDE ET SILENCE. Un résolveur qui ne répond pas n'est pas un
// domaine mal configuré. La distinction est portée jusqu'au bout du module :
// « il n'y a pas d'enregistrement » est un fait, « je n'ai pas eu de réponse »
// n'en est pas un, et seul le premier a le droit de produire un avertissement.
// Toute autre voie que celle-là finirait par accuser le domaine d'un abonné
// parce qu'un serveur DNS a hoqueté pendant deux secondes.
const DELAI_REQUETE_MS = 2500
const TENTATIVES = 1
const DELAI_TOTAL_MS = 6000

// Codes c-ares qui disent « cet enregistrement n'existe pas ». Tout le reste —
// délai dépassé, SERVFAIL, connexion refusée — est une absence de réponse.
const CODES_ABSENCE = new Set(['ENOTFOUND', 'ENODATA'])

function nouveauResolveur() {
  return new Resolver({ timeout: DELAI_REQUETE_MS, tries: TENTATIVES })
}

// Rend { su: true, valeurs } quand la question a reçu une réponse — y compris
// « rien ici », qui donne un tableau vide — et { su: false } quand elle n'en a
// pas reçu. Les fragments d'un même enregistrement TXT sont recollés : une clé
// DKIM dépasse les 255 caractères d'un fragment et arrive toujours en morceaux.
async function litTxt(resolveur, nom) {
  try {
    const brut = await resolveur.resolveTxt(nom)
    return { su: true, valeurs: (brut || []).map(parts => parts.join('')) }
  } catch (err) {
    if (CODES_ABSENCE.has(err?.code)) return { su: true, valeurs: [] }
    return { su: false, valeurs: [] }
  }
}

async function litCname(resolveur, nom) {
  try {
    const brut = await resolveur.resolveCname(nom)
    return { su: true, valeurs: brut || [] }
  } catch (err) {
    if (CODES_ABSENCE.has(err?.code)) return { su: true, valeurs: [] }
    return { su: false, valeurs: [] }
  }
}

// ── SPF ───────────────────────────────────────────────────────────────────
// Le jeton du fournisseur peut être atteint par une chaîne d'include: — un
// domaine dont le SPF pointe l'hébergeur du site, qui lui-même inclut Google,
// est parfaitement authentifié. Ne pas suivre la chaîne ferait crier au
// manquement sur une configuration correcte.
//
// La profondeur est bornée et le nombre de requêtes aussi : la norme SPF
// n'admet que dix résolutions, et une zone mal faite peut boucler sur
// elle-même. Au-delà, on ne conclut pas — on se tait.
const PROFONDEUR_SPF_MAX = 4
const REQUETES_SPF_MAX = 12

function extraitEnregistrementsSpf(valeurs) {
  return valeurs.filter(v => /^v=spf1(\s|$)/i.test(String(v || '').trim()))
}

// Rend { su, couvre, present, doublon }. `su:false` veut dire que la chaîne
// s'est interrompue sur une absence de réponse : rien n'est affirmé.
//
// `compteur` est partagé par toute la descente — un objet, pas un nombre : une
// copie par appel laisserait chaque branche repartir de zéro, et une zone qui
// se renvoie à elle-même n'aurait plus de borne que la profondeur.
async function spfCouvreFournisseur(resolveur, domaine, fournisseur, compteur, profondeur = 0) {
  if (compteur.requetes >= REQUETES_SPF_MAX || profondeur > PROFONDEUR_SPF_MAX) {
    return { su: false, couvre: false, present: false, doublon: false }
  }
  compteur.requetes++
  const lu = await litTxt(resolveur, domaine)
  if (!lu.su) return { su: false, couvre: false, present: false, doublon: false }

  const spfs = extraitEnregistrementsSpf(lu.valeurs)
  if (!spfs.length) return { su: true, couvre: false, present: false, doublon: false }
  // Deux enregistrements SPF sur un même nom ne s'additionnent pas : la norme
  // n'en admet qu'un, et leur coexistence invalide les deux. Ce n'est un
  // constat sûr qu'à la racine du domaine ; au fond d'une chaîne d'include on
  // se contente de ne pas conclure.
  const doublon = spfs.length > 1
  const jetonBas = String(fournisseur.spf || '').toLowerCase()
  const familles = fournisseur.famillesSpf || []

  const suivants = []
  for (const enr of spfs) {
    for (const mecanisme of enr.trim().split(/\s+/)) {
      const m = mecanisme.toLowerCase()
      const inclus = m.startsWith('include:') ? m.slice(8)
        : m.startsWith('+include:') ? m.slice(9)
          : m.startsWith('redirect=') ? m.slice(9)
            : null
      if (!inclus) continue
      const cible = inclus.replace(/\.$/, '')
      if (cible === jetonBas || familles.some(rx => rx.test(cible))) {
        return { su: true, couvre: true, present: true, doublon }
      }
      suivants.push(cible)
    }
  }

  // La chaîne se suit dans l'ordre, et non en parallèle : dès qu'un maillon
  // couvre, les suivants n'ont plus lieu d'être interrogés.
  let chaineSure = true
  for (const cible of suivants) {
    const r = await spfCouvreFournisseur(resolveur, cible, fournisseur, compteur, profondeur + 1)
    if (r.couvre) return { su: true, couvre: true, present: true, doublon }
    if (!r.su) chaineSure = false
  }
  // Sans couverture trouvée, on n'affirme l'absence que si TOUTE la chaîne a
  // répondu. Un maillon muet peut contenir le jeton qu'on cherche.
  return { su: chaineSure, couvre: false, present: true, doublon }
}

// ── DKIM ──────────────────────────────────────────────────────────────────
// La clé se lit en TXT au nom <sélecteur>._domainkey.<domaine>. Microsoft
// publie un CNAME vers la zone du locataire : le résolveur suit la chaîne et
// rend le TXT au bout, mais si ce bout ne répond pas, la seule présence du
// CNAME suffit à dire que la configuration a été faite.
//
// On n'affirme l'absence que si TOUS les sélecteurs candidats ont répondu
// « rien ici ». Un seul silence, et on ne conclut pas.
//
// UNE CLÉ VIDE N'EST PAS UNE CLÉ. Publier « v=DKIM1; p= » est la façon
// normalisée de RÉVOQUER un sélecteur : le champ existe, mais il n'y a plus de
// clé publique derrière, et toute signature émise sous ce nom échoue.
// example.com publie exactement cela. S'arrêter à la présence du champ aurait
// rendu un « tout est en règle » sur une signature qui ne vaut rien.
const LONGUEUR_CLE_MIN = 32
function estCleDkim(valeur) {
  const v = String(valeur || '')
  if (!/(^|;)\s*v\s*=\s*DKIM1/i.test(v) && !/(^|;)\s*p\s*=/.test(v)) return false
  const p = /(^|;)\s*p\s*=\s*([A-Za-z0-9+/=]*)/.exec(v)
  return Boolean(p && p[2] && p[2].length >= LONGUEUR_CLE_MIN)
}

// Un CNAME ne vaut preuve que s'il pointe vers une zone de clés. Beaucoup de
// registraires publient un joker *.domaine.fr vers une page de parking : sans
// ce filtre, n'importe quel domaine garé aurait paru signé, et le panneau
// aurait annoncé « rien ne bloque » à un abonné dont les messages ne sont
// signés par personne.
function estCnameDkim(cible) {
  const c = String(cible || '').toLowerCase().replace(/\.$/, '')
  return c.includes('domainkey') || c.endsWith('.onmicrosoft.com') || c.includes('dkim')
}

async function dkimPresent(resolveur, domaine, selecteurs) {
  const reponses = await Promise.all(selecteurs.map(async (sel) => {
    const nom = `${sel}._domainkey.${domaine}`
    const txt = await litTxt(resolveur, nom)
    if (txt.su && txt.valeurs.some(estCleDkim)) {
      return { su: true, present: true, selecteur: sel }
    }
    const cname = await litCname(resolveur, nom)
    if (cname.su && cname.valeurs.some(estCnameDkim)) return { su: true, present: true, selecteur: sel }
    if (!txt.su || !cname.su) return { su: false, present: false, selecteur: sel }
    return { su: true, present: false, selecteur: sel }
  }))
  const trouve = reponses.find(r => r.present)
  if (trouve) return { su: true, present: true, selecteur: trouve.selecteur }
  if (reponses.some(r => !r.su)) return { su: false, present: false, selecteur: null }
  return { su: true, present: false, selecteur: null }
}

// ── DMARC ─────────────────────────────────────────────────────────────────
// Relevé pour information, jamais comme un manquement. Un domaine sans DMARC
// n'est pas en faute : ses messages passent. Le publier est un geste de plus,
// qui vient après — et l'annoncer comme un obstacle noierait les deux réglages
// qui, eux, changent l'issue d'un envoi.
async function litDmarc(resolveur, domaine) {
  const lu = await litTxt(resolveur, `_dmarc.${domaine}`)
  if (!lu.su) return { su: false, present: false, politique: null }
  const enr = lu.valeurs.find(v => /^v=DMARC1/i.test(String(v || '').trim()))
  if (!enr) return { su: true, present: false, politique: null }
  const p = /(^|;)\s*p\s*=\s*(none|quarantine|reject)/i.exec(enr)
  return { su: true, present: true, politique: p ? p[2].toLowerCase() : null }
}

// ── Cache ─────────────────────────────────────────────────────────────────
// POURQUOI TRENTE MINUTES. Ces enregistrements ne bougent que le jour où
// quelqu'un les publie ; entre deux publications, ils sont immuables pendant
// des mois. La page Mail, elle, interroge à chaque chargement : sans cache, un
// abonné qui navigue entre ses onglets déclencherait une dizaine de résolutions
// par heure pour lire dix fois la même réponse. Trente minutes est le point où
// la charge disparaît sans que la nouvelle mette longtemps à venir — et de
// toute façon, celui qui vient de faire poser la ligne dispose du bouton
// « Revérifier », qui court-circuite le cache. Un délai plus long ne
// gagnerait rien ; un délai plus court ne servirait qu'à interroger deux fois
// pour la même réponse.
//
// L'INDÉTERMINÉ NE SE GARDE PAS TRENTE MINUTES. Un résolveur muet est un
// incident, pas un état : le retenir une demi-heure ferait durer la panne bien
// après qu'elle a cessé. Deux minutes suffisent à éviter la rafale.
const TTL_MS = 30 * 60 * 1000
const TTL_INDETERMINE_MS = 2 * 60 * 1000
const CACHE_MAX = 500

const cache = new Map()

function litCache(cle) {
  const e = cache.get(cle)
  if (!e) return null
  const ttl = e.resultat.etat === 'indetermine' ? TTL_INDETERMINE_MS : TTL_MS
  if (Date.now() - e.pose > ttl) { cache.delete(cle); return null }
  return e.resultat
}

function poseCache(cle, resultat) {
  // Purge paresseuse : le cache est indexé par domaine d'abonné, il ne grandit
  // pas vite, mais rien ne doit pouvoir le faire croître sans fin. Les entrées
  // les plus anciennes partent en premier — Map conserve l'ordre d'insertion.
  if (cache.size >= CACHE_MAX) {
    for (const k of cache.keys()) {
      cache.delete(k)
      if (cache.size < CACHE_MAX) break
    }
  }
  cache.set(cle, { pose: Date.now(), resultat })
}

// ── Le contrôle ───────────────────────────────────────────────────────────

function sansObjet(motif, domaine) {
  return { etat: 'sans_objet', motif, domaine: domaine || null, fournisseur: null, manquants: [] }
}

function indetermine(domaine, fournisseur) {
  return {
    etat: 'indetermine',
    motif: 'dns_muet',
    domaine,
    fournisseur: fournisseur ? { cle: fournisseur.cle, nom: fournisseur.nom } : null,
    manquants: []
  }
}

// Le contrôle proprement dit. `boite` décrit ce d'où l'abonné écrit :
//   { email, provider, smtp_host, envoiParDomaineVerifie }
// `provider` vaut 'google', 'microsoft' ou 'imap' ; `envoiParDomaineVerifie`
// dit que ses messages ne partent PAS de cette boîte mais du domaine qu'il a
// fait vérifier pour ses campagnes — auquel cas il n'y a rien à contrôler ici.
//
// Ne lève jamais : tout échec devient un état, et le seul état qu'un échec
// puisse produire est le silence.
export async function controleAuthentification(boite, { forcer = false } = {}) {
  const email = String(boite?.email || '').trim().toLowerCase()
  const at = email.lastIndexOf('@')
  const domaine = at < 0 ? '' : email.slice(at + 1)
  if (!domaine || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domaine)) {
    return sansObjet('adresse_illisible', null)
  }
  // Les messages partent par le domaine vérifié des campagnes : ses SPF, DKIM
  // et DMARC ont été posés à la vérification et sont ceux du transport réel.
  // Contrôler ici le fournisseur de la boîte accuserait un domaine en règle.
  if (boite?.envoiParDomaineVerifie) return sansObjet('domaine_verifie', domaine)
  if (estDomaineGrandPublic(domaine)) return sansObjet('grand_public', domaine)

  const fournisseur = boite?.provider === 'imap'
    ? fournisseurDepuisHoteSmtp(boite?.smtp_host)
    : fournisseurDepuisCle(boite?.provider)

  const cle = (fournisseur ? fournisseur.cle : 'inconnu') + '|' + domaine
  if (!forcer) {
    const garde = litCache(cle)
    if (garde) return garde
  }

  const resolveur = nouveauResolveur()
  let expire = false
  const garde = new Promise(resolve => setTimeout(() => {
    expire = true
    try { resolveur.cancel() } catch (e) {}
    resolve(null)
  }, DELAI_TOTAL_MS))

  let resultat
  try {
    const travail = fournisseur
      ? controleFournisseurConnu(resolveur, domaine, fournisseur)
      : controleFournisseurInconnu(resolveur, domaine, boite?.smtp_host)
    resultat = await Promise.race([travail, garde])
  } catch (e) {
    resultat = null
  }
  if (!resultat || expire) resultat = indetermine(domaine, fournisseur)

  poseCache(cle, resultat)
  return resultat
}

async function controleFournisseurConnu(resolveur, domaine, fournisseur) {
  const [spf, dkim, dmarc] = await Promise.all([
    spfCouvreFournisseur(resolveur, domaine, fournisseur, { requetes: 0 }),
    dkimPresent(resolveur, domaine, fournisseur.selecteurs),
    litDmarc(resolveur, domaine)
  ])
  // Un seul silence sur SPF ou DKIM et rien n'est annoncé. DMARC muet, lui, ne
  // suffit pas à taire le reste : il n'entre pas dans le verdict.
  if (!spf.su || !dkim.su) return indetermine(domaine, fournisseur)

  const manquants = []
  if (spf.doublon) manquants.push('spf_doublon')
  else if (!spf.couvre) manquants.push('spf')
  if (!dkim.present) manquants.push('dkim')

  return {
    etat: manquants.length ? 'incomplet' : 'complet',
    motif: null,
    domaine,
    fournisseur: { cle: fournisseur.cle, nom: fournisseur.nom },
    manquants,
    spf: { present: spf.present, couvre: spf.couvre, doublon: spf.doublon },
    dkim: { present: dkim.present, selecteur: dkim.selecteur },
    dmarc: { present: dmarc.su ? dmarc.present : null, politique: dmarc.politique }
  }
}

// Fournisseur non reconnu — une boîte branchée en manuel sur un hébergeur dont
// on ne connaît ni le jeton SPF ni le sélecteur DKIM. On ne cherche pas à
// deviner : la seule chose qui reste vraie sans connaître personne, c'est
// qu'un domaine qui ne publie AUCUN SPF n'authentifie aucun expéditeur, quel
// qu'il soit. Ce constat-là ne peut pas être un faux. Tout le reste se tait.
async function controleFournisseurInconnu(resolveur, domaine, hoteSmtp) {
  const lu = await litTxt(resolveur, domaine)
  if (!lu.su) return indetermine(domaine, null)
  const spfs = extraitEnregistrementsSpf(lu.valeurs)
  if (spfs.length) {
    // Un SPF est là. Sans savoir qui il doit autoriser, on ne peut ni le
    // valider ni le contester : silence. Le motif le dit tel quel — ce n'est
    // pas un résolveur muet, et confondre les deux tromperait la première
    // personne qui lira cette réponse pour comprendre un cas d'abonné.
    return { ...indetermine(domaine, null), motif: 'fournisseur_inconnu' }
  }
  const dmarc = await litDmarc(resolveur, domaine)
  return {
    etat: 'incomplet',
    motif: 'fournisseur_inconnu',
    domaine,
    fournisseur: null,
    hote_smtp: hoteSmtp || null,
    manquants: ['spf_absent'],
    spf: { present: false, couvre: false, doublon: false },
    dkim: { present: null, selecteur: null },
    dmarc: { present: dmarc.su ? dmarc.present : null, politique: dmarc.politique }
  }
}

// ── L'annonce ─────────────────────────────────────────────────────────────
// Le texte est écrit ici et non dans la page : c'est le même module qui sait
// ce qui manque et qui sait le dire. La page n'a qu'à l'afficher — elle ne
// reformule rien, elle n'interprète aucun code.
//
// ON N'ÉNONCE JAMAIS UN PROBLÈME : ON DONNE LA MARCHE À SUIVRE ET CE QU'ELLE
// APPORTE. « Vos messages risquent d'arriver en indésirables » et « vos
// messages sont refusés » sont l'un et l'autre exacts, et l'un et l'autre à
// proscrire : ils mettent l'abonné en défaut sur une zone DNS qu'il n'a
// souvent jamais ouverte, et le laissent avec un verdict au lieu d'un geste.
// L'objet n'est pas « votre domaine est mal réglé », c'est « je configure ma
// messagerie pour améliorer ma prospection ».
//
// LE CADRAGE ORIENTE, IL NE DISSIMULE PAS. Le fait reste exact — deux SPF qui
// s'annulent sont dits comme tels, une politique DMARC stricte est nommée — et
// rien n'est promis de plus qu'avant : ces réglages lèvent l'obstacle le plus
// courant, ils ne garantissent pas la boîte de réception.
//
// LA PHRASE À TRANSMETTRE EST ÉCRITE POUR ÊTRE COLLÉE TELLE QUELLE dans un
// message à qui gère le domaine. Elle s'adresse à un technicien : elle reste
// précise et factuelle, et elle est la seule à porter les noms techniques.
// L'abonné n'a pas à les comprendre, seulement à les transmettre.

// Une politique DMARC en `reject` ou `quarantine` demande aux serveurs
// destinataires de suivre à la lettre ce que le domaine déclare. Avec un SPF ou
// un DKIM encore à poser, c'est elle qui décide de l'issue des envois : le
// réglage passe alors en tête, et l'urgence se dit sans peindre l'échec.
// `none` n'a pas cet effet et ne change donc rien à l'annonce.
function dmarcContraignant(dmarc) {
  return Boolean(dmarc && dmarc.present === true && (dmarc.politique === 'reject' || dmarc.politique === 'quarantine'))
}

const ACCROCHE_ORDINAIRE = 'Une demande à transmettre à qui gère votre domaine, et vos messages seront reconnus comme venant de vous.'
const ACCROCHE_PRIORITAIRE = 'Chez vous, ce réglage est le premier à faire : c\'est lui qui décide si vos messages atteignent leurs destinataires.'

export function redigeAnnonce(resultat) {
  if (!resultat) return null
  if (resultat.etat === 'complet') {
    return {
      niveau: 'ok',
      titre: 'Votre domaine est configuré pour la prospection',
      accroche: null,
      phrase: `Le domaine ${resultat.domaine} autorise ${resultat.fournisseur.nom} à écrire en votre nom, et vos messages partent signés : les serveurs qui les reçoivent les reconnaissent comme venant de vous. C'est le réglage qui pèse le plus sur la réception, et il est en place. Le reste se joue sur le contenu de vos messages et sur vos destinataires.`,
      aQui: null,
      demande: null
    }
  }
  if (resultat.etat !== 'incomplet') return null

  const d = resultat.domaine
  const manque = resultat.manquants
  const prioritaire = dmarcContraignant(resultat.dmarc)
  // `titre` et `accroche` disent le geste et ce qu'il apporte ; le corps
  // explique le mécanisme et ce qui reste à poser. Rien, dans cet ordre, ne
  // commence par ce qui ne va pas.
  const titre = prioritaire
    ? 'Le premier réglage à faire pour vos envois'
    : 'Un réglage pour améliorer la réception de vos messages'
  const accroche = prioritaire ? ACCROCHE_PRIORITAIRE : ACCROCHE_ORDINAIRE
  const aQui = `Le réglage se fait chez qui gère le domaine ${d} : l'agence ou le prestataire qui s'occupe de votre site, ou l'hébergeur chez qui le nom a été acheté. C'est l'affaire de quelques minutes pour cette personne, et le message ci-dessous lui donne tout ce dont elle a besoin.`

  if (resultat.motif === 'fournisseur_inconnu') {
    const hote = resultat.hote_smtp ? ` (${resultat.hote_smtp})` : ''
    return {
      niveau: prioritaire ? 'prioritaire' : 'reglage',
      titre,
      accroche,
      phrase: `Vos messages partent des adresses @${d}. Les serveurs qui les reçoivent consultent votre domaine pour savoir quel serveur a le droit d'écrire en votre nom : il reste à y déclarer le vôtre. Le réglage se fait une fois et vaut pour tous vos envois à venir.`,
      aQui,
      demande: `Bonjour, nous envoyons nos e-mails professionnels depuis les adresses @${d}, par notre serveur d'envoi${hote}. Le domaine ${d} ne publie aujourd'hui aucun enregistrement SPF. Pourriez-vous en publier un qui autorise ce serveur d'envoi, et activer la signature DKIM si notre hébergeur de messagerie la propose ? Merci d'avance.`
    }
  }

  const f = resultat.fournisseur
  const morceaux = []
  if (manque.includes('spf_doublon')) {
    morceaux.push(`ne garder qu'un seul enregistrement SPF sur le domaine (il y en a deux aujourd'hui, ce qui les annule tous les deux), contenant la mention include:${FOURNISSEURS[f.cle].spf}`)
  } else if (manque.includes('spf')) {
    morceaux.push(`ajouter la mention include:${FOURNISSEURS[f.cle].spf} dans l'enregistrement SPF du domaine (l'unique enregistrement TXT commençant par v=spf1 — s'il n'y en a pas, le créer)`)
  }
  if (manque.includes('dkim')) {
    morceaux.push(FOURNISSEURS[f.cle].demandeDkim(d))
  }

  // Le geste suit ce qui manque, sans jamais nommer un réglage déjà en place
  // comme s'il restait à faire. Deux SPF concurrents se disent ici « regrouper
  // en une seule ligne », ET RIEN DE PLUS : qu'il y en ait deux aujourd'hui et
  // que cela les annule tous les deux est un constat technique, il n'intéresse
  // que le prestataire, et il figure dans le bloc qui lui est destiné.
  //
  // Les gestes s'enchaînent en « il reste à X et à Y » : aucun ne porte de
  // virgule, sans quoi la seconde branche se détacherait de la première.
  const gestes = []
  if (manque.includes('spf_doublon')) gestes.push(`regrouper les autorisations d'envoi de votre domaine en une seule ligne incluant ${f.nom}`)
  else if (manque.includes('spf')) gestes.push(`y déclarer ${f.nom} comme expéditeur autorisé`)
  if (manque.includes('dkim')) gestes.push('activer la signature de vos messages')

  return {
    niveau: prioritaire ? 'prioritaire' : 'reglage',
    titre,
    accroche,
    phrase: `Vos messages partent des adresses @${d}. Les serveurs qui les reçoivent consultent votre domaine pour savoir qui écrit en votre nom : il reste à ${gestes.join(' et à ')}. Le réglage se fait une fois et vaut pour tous vos envois à venir.`,
    aQui,
    demande: `Bonjour, nous envoyons nos e-mails professionnels via ${f.nom} depuis les adresses @${d}. Pourriez-vous, dans la zone DNS du domaine ${d}, ${morceaux.join(' ; puis ')} ? Merci d'avance.`
  }
}
