// Audience du site public — visiteurs ANONYMES, sans compte.
//
// Ce module ne mesure PAS l'activité des abonnés. Il n'y a ici aucun `userId`,
// aucun lien vers la table `user`, aucune jointure possible avec elle : ce qui
// est compté, ce sont des arrivées sur les pages ouvertes à tous (accueil,
// vitrine, pages légales). L'activité des comptes, elle, se lit ailleurs —
// `last_seen_at` sur `user` (server/services/last-seen.js) pour le retour, et
// les tables de travail pour l'usage.
//
// CE QUI N'EST PAS ÉCRIT. Ni l'adresse IP, ni l'User-Agent n'entrent en base.
// Ce qui est stocké est un JETON D'UNICITÉ : le HMAC-SHA256 du couple (IP,
// User-Agent) sous un SEL ALÉATOIRE RENOUVELÉ CHAQUE JOUR et gardé en mémoire
// seulement. Le sel n'est jamais persisté ; au redémarrage du process il est
// retiré, et l'ancien est irrécupérable. Conséquences, toutes voulues :
//
//   • le jeton n'est pas réversible vers une IP, même en connaissant le sel —
//     mais surtout le sel n'existe plus le lendemain, donc l'espace des IP
//     n'est même plus énumérable a posteriori ;
//   • un même visiteur revenu le lendemain porte un jeton DIFFÉRENT. Le
//     dédoublonnage est donc possible à l'intérieur d'une journée, et impossible
//     au-delà — par construction. C'est pour cela que le cumul hebdomadaire est
//     une somme de visiteurs quotidiens (« visiteurs-jours ») et jamais un
//     décompte d'individus sur la semaine : voir agregerVisitesJour.
//
// AUCUN COOKIE, aucun identifiant remis au navigateur, aucun stockage côté
// client. La mesure est entièrement serveur ; rien n'est déposé chez le
// visiteur, donc rien n'est à recueillir au titre du consentement.
//
// LA MESURE NE RALENTIT NI NE CASSE LE RENDU. Le middleware ne fait qu'accrocher
// un écouteur sur `finish` et rendre la main ; l'enregistrement est empilé en
// mémoire et écrit par lots sur une horloge propre. Aucun `await` n'est posé sur
// le chemin de la requête, et toute erreur d'écriture est avalée avec un warn :
// perdre un lot d'audience est sans conséquence, retarder une page ne l'est pas.
//
// CROISSANCE DE LA TABLE. `visite` est du DÉTAIL, borné à 90 jours. Le cron
// quotidien agrège chaque journée révolue dans `visite_jour` (une ligne par
// date, conservée indéfiniment) puis supprime le détail périmé. Le cumul depuis
// la mise en service se lit donc TOUJOURS sur `visite_jour`, jamais par un
// balayage de `visite` — c'est le seul décompte qui ne grossit pas avec le
// trafic.
//
// ÉTAT EN MÉMOIRE, jamais en base : le sel du jour, la file d'écriture et la
// fenêtre de présence (« visiteurs à l'instant »). Le tout est propre au
// process ; un redémarrage remet ces trois choses à zéro sans rien corrompre en
// base. L'instance est unique côté Railway, donc la présence est exacte ; si le
// service passait à plusieurs instances, elle deviendrait un décompte par
// instance — à retravailler ce jour-là, pas avant.

import { createHmac, randomBytes } from 'node:crypto'
import { getDb } from '../../lib/surreal.js'

// ── Robots ────────────────────────────────────────────────────────────────
// Exclusion par motif d'User-Agent. La liste est volontairement courte et
// lisible plutôt qu'exhaustive : elle attrape les familles qui pèsent (moteurs
// et aspirateurs sous `bot`/`crawler`/`spider`), les dépliages de lien des
// messageries et réseaux (`preview`), les sondes de disponibilité (`monitor`),
// les appels en ligne de commande (`curl`, `wget`) et les navigateurs pilotés
// (`headless`). Un robot qui se déclare autrement passera : aucune liste de
// motifs ne clôt le sujet, et prétendre le contraire donnerait à ces chiffres
// une précision qu'ils n'ont pas.
const ROBOTS = /bot|crawler|spider|preview|monitor|curl|wget|headless/i

// Un User-Agent VIDE est traité comme un robot. Aucun navigateur n'en envoie ;
// c'est la signature d'un script, et le compter gonflerait l'audience du bruit
// des sondes anonymes.

// ── Jour civil, fuseau Europe/Paris ───────────────────────────────────────
// Le fuseau est celui du cron (server/services/cron.js) : la journée agrégée
// doit être la journée telle que la vit le lecteur du tableau, pas la journée
// UTC. `fr-CA` est choisi pour sa seule vertu utile ici — il formate en
// AAAA-MM-JJ, donc l'ordre lexicographique des chaînes est l'ordre des dates.
const FORMAT_JOUR = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
})

export function jourParis(d = new Date()) {
  return FORMAT_JOUR.format(d)
}

// Décalage en jours sur une date AAAA-MM-JJ. L'arithmétique se fait à midi UTC :
// un changement d'heure déplace les millisecondes, jamais le quantième obtenu.
// Exporté : le découpage en semaines de `visite_jour` s'appuie dessus, et deux
// arithmétiques de calendrier dans la maison finiraient par diverger d'un jour.
export function decalerJour(jour, n) {
  const t = Date.parse(jour + 'T12:00:00Z')
  if (Number.isNaN(t)) return jour
  return new Date(t + n * 86400000).toISOString().slice(0, 10)
}

// ── Sel du jour ───────────────────────────────────────────────────────────
// Renouvelé dès que le quantième change, sans horloge dédiée : la rotation se
// fait à la première mesure du nouveau jour. 32 octets d'aléa cryptographique.
let selJour = null
let selValeur = null

function selDuJour() {
  const jour = jourParis()
  if (jour !== selJour) {
    selJour = jour
    selValeur = randomBytes(32)
  }
  return selValeur
}

// 128 bits de HMAC suffisent : le jeton ne sert qu'à dédoublonner à l'intérieur
// d'une journée, jamais à identifier. Tronquer réduit d'autant ce qui dort en
// base sans changer la probabilité de collision à l'échelle d'un site.
function calculerJeton(ip, ua) {
  return createHmac('sha256', selDuJour()).update(ip + '\n' + ua).digest('hex').slice(0, 32)
}

// ── Fenêtre de présence — « visiteurs à l'instant » ───────────────────────
// Jetons distincts vus dans les cinq dernières minutes. Purement en mémoire :
// cette valeur ne descend JAMAIS en base, elle n'a pas d'histoire à conserver.
const PRESENCE_MS = 5 * 60 * 1000
const PRESENCE_MAX = 5000
const presence = []

function noterPresence(jeton, maintenant) {
  presence.push({ jeton, ts: maintenant })
  // Plafond de sécurité : sous un pic anormal la fenêtre reste bornée, on perd
  // les plus anciennes entrées de la fenêtre plutôt que la mémoire du process.
  if (presence.length > PRESENCE_MAX) presence.splice(0, presence.length - PRESENCE_MAX)
}

export function visiteursALInstant() {
  const seuil = Date.now() - PRESENCE_MS
  while (presence.length && presence[0].ts < seuil) presence.shift()
  const distincts = new Set()
  for (const p of presence) distincts.add(p.jeton)
  return distincts.size
}

// ── File d'écriture ───────────────────────────────────────────────────────
// Empilement en mémoire, vidage sur horloge propre. Le plafond de la file
// protège d'une base injoignable : au-delà, les plus anciennes entrées sont
// abandonnées — la mesure se dégrade, le process tient.
const FLUSH_MS = 10000
const LOT_MAX = 100
const FILE_MAX = 1000
const file = []
let horloge = null

function demarrerHorloge() {
  if (horloge) return
  horloge = setInterval(() => { viderFile().catch(() => {}) }, FLUSH_MS)
  // Une horloge d'audience ne doit pas retenir le process en vie.
  if (typeof horloge.unref === 'function') horloge.unref()
}

async function viderFile() {
  if (!file.length) return
  const lot = file.splice(0, LOT_MAX)
  try {
    const db = await getDb()
    // Écriture en un aller-retour. `INSERT INTO <table> $param` accepte un
    // tableau d'objets ; le repli ci-dessous couvre le cas où cette forme
    // serait refusée, pour qu'un lot ne soit jamais perdu en silence.
    try {
      await db.query('INSERT INTO visite $lignes', { lignes: lot })
    } catch (e) {
      for (const l of lot) {
        await db.query(
          'CREATE visite SET vu_a = time::now(), jour = $jour, chemin = $chemin, jeton = $jeton',
          l
        )
      }
    }
  } catch (e) {
    console.warn('[visites] lot perdu :', e.message)
  }
}

// ── Ce qui compte comme page publique ─────────────────────────────────────
// Trois exclusions, dans cet ordre :
//   1. l'API (`/api/…`) et tout ce qui n'est pas un GET — une page vue est un
//      GET ; HEAD est le verbe des sondes, POST celui des formulaires ;
//   2. les pages applicatives, /superadmin compris — l'appelant fournit le
//      prédicat, c'est le MÊME que celui du portillon d'authentification
//      (isProtectedHtmlRoute), pour qu'aucune des deux listes ne dérive ;
//   3. les fichiers statiques — reconnus à leur extension. Restent donc les
//      chemins sans extension (servis en .html par express.static) et les .html
//      explicites, moins les fragments de /components/ que le navigateur va
//      chercher en second temps : ce sont des morceaux de page, pas des pages.
const EXTENSION = /\.[a-z0-9]{1,8}$/i

function estDocument(chemin) {
  if (chemin === '/') return true
  if (chemin.startsWith('/components/')) return false
  const dernier = chemin.slice(chemin.lastIndexOf('/') + 1)
  if (!EXTENSION.test(dernier)) return true
  return /\.html?$/i.test(dernier)
}

// Chemin normalisé : sans barre finale, sans .html, /index ramené à /. Deux URL
// qui servent le même fichier doivent compter sur la même ligne, sinon le
// palmarès des pages se fend en doublons.
function normaliserChemin(chemin) {
  let p = String(chemin || '/').replace(/\.html?$/i, '').replace(/\/+$/, '')
  if (p === '' || p === '/index') p = '/'
  return p.slice(0, 200)
}

function enregistrer(chemin, ip, ua) {
  const maintenant = Date.now()
  const jeton = calculerJeton(ip, ua)
  noterPresence(jeton, maintenant)
  file.push({ jour: jourParis(), chemin, jeton })
  if (file.length > FILE_MAX) file.splice(0, file.length - FILE_MAX)
  demarrerHorloge()
}

// Fabrique du middleware. `estPageApp` est injecté par server.js pour que la
// liste des routes applicatives reste définie à un seul endroit.
export function creerMesureAudience({ estPageApp }) {
  return function mesureAudience(req, res, next) {
    try {
      const chemin = req.path || '/'
      if (req.method === 'GET'
        && !chemin.startsWith('/api/')
        && !estPageApp(chemin)
        && estDocument(chemin)) {
        const ua = String(req.headers['user-agent'] || '')
        if (ua && !ROBOTS.test(ua)) {
          const ip = String(req.ip || '')
          const propre = normaliserChemin(chemin)
          // Sur `finish` : le statut est connu. Seul un 200 est une page vue —
          // les 404 et les 302 vers /login n'ont rien montré à personne.
          res.on('finish', () => {
            if (res.statusCode !== 200) return
            try { enregistrer(propre, ip, ua) } catch (e) { /* jamais bloquant */ }
          })
        }
      }
    } catch (e) {
      // Une mesure d'audience ne fait pas échouer un rendu de page.
      console.warn('[visites] mesure ignorée :', e.message)
    }
    next()
  }
}

// ── Agrégation quotidienne + purge du détail ──────────────────────────────
// Appelée par le cron quotidien. Deux gestes distincts :
//
//   • AGRÉGER les journées RÉVOLUES qui ne le sont pas encore. La veille est la
//     dernière traitée : agréger le jour courant donnerait une ligne fausse
//     qu'il faudrait réécrire. Le point de reprise est le dernier `visite_jour`
//     connu — donc une instance arrêtée plusieurs jours rattrape à son retour,
//     dans la limite de RATTRAPAGE_MAX pour qu'un long arrêt ne se paie pas en
//     une seule passe.
//
//   • PURGER le détail de plus de RETENTION_JOURS. L'agrégat, lui, reste.
//
// Chaque journée est lue par une ÉGALITÉ sur `jour` (champ indexé), jamais par
// un GROUP BY sur toute la table : l'instance est petite, et une agrégation qui
// balaie le détail est exactement ce qui la met à genoux.
const RETENTION_JOURS = 90
const RATTRAPAGE_MAX = 90

export async function agregerVisitesJour() {
  const db = await getDb()
  const hier = decalerJour(jourParis(), -1)

  const dernierAgrege = (await db.query(
    'SELECT jour FROM visite_jour ORDER BY jour DESC LIMIT 1'
  ))?.[0]?.[0]?.jour

  let depart
  if (dernierAgrege) {
    depart = decalerJour(dernierAgrege, 1)
  } else {
    const plusVieux = (await db.query(
      'SELECT jour FROM visite ORDER BY jour ASC LIMIT 1'
    ))?.[0]?.[0]?.jour
    if (!plusVieux) return { jours: 0, vues: 0, visiteurs: 0, purgees: 0 }
    depart = plusVieux
  }

  let jours = 0, vues = 0, visiteurs = 0
  for (let j = depart; j <= hier && jours < RATTRAPAGE_MAX; j = decalerJour(j, 1)) {
    const lignes = (await db.query('SELECT jeton FROM visite WHERE jour = $jour', { jour: j }))?.[0] || []
    const distincts = new Set()
    for (const l of lignes) distincts.add(l.jeton)
    const v = lignes.length
    const u = distincts.size

    // UPDATE-puis-CREATE plutôt qu'UPSERT : l'identifiant de ligne n'est pas
    // dérivé de la date, et l'index UNIQUE sur `jour` interdit le doublon même
    // si deux passes se croisaient.
    const maj = await db.query(
      'UPDATE visite_jour SET vues = $vues, visiteurs = $visiteurs, agrege_a = time::now() WHERE jour = $jour',
      { jour: j, vues: v, visiteurs: u }
    )
    if (!(maj?.[0]?.length)) {
      await db.query(
        'CREATE visite_jour SET jour = $jour, vues = $vues, visiteurs = $visiteurs, agrege_a = time::now()',
        { jour: j, vues: v, visiteurs: u }
      )
    }
    jours++; vues += v; visiteurs += u
  }

  const limite = decalerJour(jourParis(), -RETENTION_JOURS)
  const aPurger = (await db.query(
    'SELECT count() AS n FROM visite WHERE jour < $limite GROUP ALL', { limite }
  ))?.[0]?.[0]?.n || 0
  if (aPurger > 0) await db.query('DELETE visite WHERE jour < $limite', { limite })

  return { jours, vues, visiteurs, purgees: aPurger }
}

// ── migration idempotente ─────────────────────────────────────────────────
export async function runVisitesMigration() {
  const db = await getDb()
  const queries = [
    // ── visite — le DÉTAIL, borné à 90 jours (cf. agregerVisitesJour) ──
    'DEFINE TABLE IF NOT EXISTS visite SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS vu_a ON visite TYPE datetime DEFAULT time::now()',
    // Jour civil Europe/Paris en AAAA-MM-JJ. Chaîne et non datetime : toutes
    // les lectures sont des ÉGALITÉS sur cette valeur, et l'ordre lexical d'une
    // date ISO est son ordre chronologique — la purge par comparaison marche
    // sans arithmétique de fuseau.
    'DEFINE FIELD IF NOT EXISTS jour ON visite TYPE string',
    // Chemin normalisé, sans .html ni barre finale, tronqué à 200 caractères.
    'DEFINE FIELD IF NOT EXISTS chemin ON visite TYPE string',
    // Jeton d'unicité — HMAC salé de (IP, User-Agent), sel du jour gardé en
    // mémoire seule. NI l'IP NI l'User-Agent ne sont stockés (cf. en-tête).
    'DEFINE FIELD IF NOT EXISTS jeton ON visite TYPE string',
    // Seul index : la borne de lecture ET de purge est la journée.
    'DEFINE INDEX IF NOT EXISTS idx_visite_jour ON visite FIELDS jour',

    // ── visite_jour — l'AGRÉGAT, conservé indéfiniment ──
    'DEFINE TABLE IF NOT EXISTS visite_jour SCHEMAFULL',
    'DEFINE FIELD IF NOT EXISTS jour ON visite_jour TYPE string',
    'DEFINE FIELD IF NOT EXISTS vues ON visite_jour TYPE number',
    // Jetons distincts de la journée. Sommable d'un jour à l'autre en
    // « visiteurs-jours » seulement : le sel tournant chaque nuit, deux jours
    // ne partagent aucun jeton comparable.
    'DEFINE FIELD IF NOT EXISTS visiteurs ON visite_jour TYPE number',
    'DEFINE FIELD IF NOT EXISTS agrege_a ON visite_jour TYPE datetime DEFAULT time::now()',
    'DEFINE INDEX IF NOT EXISTS idx_visite_jour_unique ON visite_jour FIELDS jour UNIQUE'
  ]
  for (const q of queries) {
    try {
      await db.query(q)
    } catch (e) {
      console.error('[visites] schéma :', q, '→', e.message)
    }
  }
}
