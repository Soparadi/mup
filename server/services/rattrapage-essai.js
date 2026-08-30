// Rattrapage d'essai : la cicatrisation de l'approbation manuelle.
//
// POURQUOI CE MODULE EXISTE. Un compte inscrit pendant que la porte est armée
// (lib/approbation.js) n'a ni trial_started_at, ni trial_ends_at, ni
// trial_status. Tant que la porte est armée, c'est voulu : c'est ce qui le
// tient hors des relances, de la bascule automatique et de la purge. Mais la
// variable INSCRIPTION_APPROBATION vidée, ce même compte tombe sur la branche
// par défaut de deriveAppState, 'trial_active', et devient un accès gratuit
// SANS TERME : invisible aux relances J-2 et J-0, invisible à l'avertissement
// de purge, invisible à la purge, et sans courriel de bienvenue.
//
// La consigne « approuver ou supprimer les comptes en attente avant de vider
// la variable » réglait le cas, mais elle demandait de se souvenir d'un geste
// des semaines plus tard. Elle n'était pas tenable. Ce module la remplace :
// le retrait de la variable redevient une ligne effacée dans Railway, rien
// d'autre.
//
// DEUX APPELANTS, UNE SEULE RÈGLE.
//   - à la présentation : les deux portillons de session
//     (server/middleware/requireAuth.js), à côté de toucherLastSeen. C'est le
//     seul endroit que tout compte traverse, quoi qu'il fasse : requireAuth
//     voit les appels d'API, requireAuthHtml voit les ouvertures de page.
//   - une fois par jour : le passage cron, pour les comptes DORMANTS. Un
//     compte qui ne revient jamais ne se présente jamais, donc ne guérirait
//     jamais, et resterait éternellement hors de la boucle de suppression que
//     subit tout essai jamais converti. C'est ce passage qui rend « effacer la
//     variable suffit » vrai sans réserve.
//
// LA CONDITION EST trial_started_at ABSENT, et rien d'autre y ajouté. Pas
// approved_at : une date d'approbation n'existe jamais sans les dates d'essai,
// SAUF si la route d'approbation a écrit à moitié, et ce compte-là mérite
// exactement le même rattrapage. La condition retenue couvre donc aussi, et
// délibérément, le compte dont l'UPDATE de dates a échoué au signup (échec
// silencieux documenté dans server/auth/routes.js) : c'est le même défaut, un
// compte sans terme, et le même remède.

import { getDb } from '../../lib/surreal.js'
import { approbationRequise } from '../../lib/approbation.js'
import { isVip } from '../../lib/vip.js'
import { invalidateSessionCacheByUserId } from '../auth/surreal-adapter.js'
import { sendWelcome } from './email.js'

// Décision pure, sans I/O : elle tourne sur CHAQUE requête authentifiée, elle
// ne doit donc rien coûter au compte ordinaire. Toutes les valeurs qu'elle lit
// sont déjà en mémoire, la session rendant le record complet (user_id.*).
//
// Quatre gardes, dans l'ordre du moins cher au plus parlant :
//   - porte armée : on ne démarre surtout pas l'essai que la porte retient ;
//   - VIP : ni le propriétaire ni un compte bypass n'a d'essai à recevoir ;
//   - essai déjà posé : la condition de fond, et ce qui rend l'opération
//     naturellement unique, sans verrou ni drapeau supplémentaire ;
//   - abonnement ou conversion : ceinture, on ne réécrit JAMAIS par-dessus un
//     compte payant. Aucun chemin connu n'y mène, /api/stripe/* étant la seule
//     route qu'un compte en attente puisse encore appeler ; deux comparaisons
//     ferment la question.
export function aBesoinDeRattrapage(user) {
  if (approbationRequise()) return false
  if (!user) return false
  if (isVip(user)) return false
  if (user.trial_started_at) return false
  if (user.subscription_status) return false
  if (user.trial_status === 'converted') return false
  return true
}

// Tentatives en vol, par compte. NON un pas de temps comme last-seen.js : la
// condition s'éteint d'elle-même au premier succès, il n'y a rien à espacer.
// Ce que cette carte empêche, c'est la RAFALE : une ouverture de page tire
// cinq appels d'API en parallèle, qui liraient tous le même user sans dates.
// L'élection en base tranche déjà entre processus ; ceci évite juste de lui
// envoyer cinq requêtes pour rien. Toujours vidée dans un finally.
const enVol = new Set()

// Écriture élue. Une seule requête décide QUI pose les dates : la clause
// `WHERE trial_started_at IS NONE` posée sur l'UPDATE lui-même. Le perdant
// reçoit un tableau vide et s'arrête là, sans courriel.
//
// C'est le motif éprouvé de markEmailSent (server/services/trial-emails.js),
// dont le commentaire porte la mesure du 19/08/2026 contre movup-prod : un
// UPDATE qui ne touche aucun enregistrement rend [] sans lever.
//
// RETURN BEFORE, et pas AFTER : l'état d'AVANT est la source autorisée pour
// décider du courriel. Le `user` reçu en argument vient du cache de session
// (30 s), il peut porter un welcome_email_sent_at périmé ; le retour de cette
// requête-ci, non.
//
// REPLI, si cette forme ne se comportait pas comme attendu (un UPDATE ciblé
// qui ignorerait la clause, ou un RETURN BEFORE vide sur succès) : réclamer
// d'abord welcome_email_sent_at par une écriture conditionnelle, et ne poser
// les dates qu'ensuite. L'élection changerait de champ, pas de principe.
async function poserEssai(uid) {
  const db = await getDb()
  const r = await db.query(
    `UPDATE type::record('user', $uid)
       SET trial_started_at = time::now(),
           trial_ends_at = time::now() + 14d,
           trial_status = 'active'
     WHERE trial_started_at IS NONE
     RETURN BEFORE`,
    { uid }
  )
  const avant = r?.[0]?.[0]
  // Perdu l'élection, ou compte disparu entre la lecture et l'écriture.
  if (!avant) return { pose: false, bienvenue: 'ignoree' }

  // Le cache de session porte encore le compte sans dates : l'invalider, sinon
  // la requête suivante le relit périmé et retente pour rien.
  invalidateSessionCacheByUserId(uid)

  // Même règle qu'à l'approbation manuelle : pas de bienvenue à une adresse
  // non vérifiée. La route de vérification s'en chargera, le compte n'étant
  // plus en attente d'ici là. Le drapeau reste la ceinture des deux chemins.
  if (avant.email_verified !== true || avant.welcome_email_sent_at) {
    return { pose: true, bienvenue: 'ignoree' }
  }
  try {
    await sendWelcome(avant)
    await db.query(
      'UPDATE type::record("user", $uid) SET welcome_email_sent_at = time::now()',
      { uid }
    )
    return { pose: true, bienvenue: 'envoyee' }
  } catch (e) {
    // L'essai EST démarré quoi qu'il arrive : un courriel raté ne doit pas
    // laisser le compte sans terme. Le drapeau n'étant pas posé, le passage
    // quotidien ne le rejouera pas non plus, la condition de fond étant
    // désormais fausse. C'est un courriel perdu, pas un compte perdu.
    console.warn('[rattrapage-essai] bienvenue échouée pour', uid, ':', e.message)
    return { pose: true, bienvenue: 'echec' }
  }
}

// Voie de la présentation. Ne rend AUCUNE promesse à attendre, même motif que
// toucherLastSeen : le portillon d'authentification ne doit pas dépendre de la
// réussite d'une écriture. La requête en cours passe avec le compte tel qu'il
// est, c'est-à-dire sans trial_status, donc sur la branche par défaut de
// deriveAppState, 'trial_active' : elle est servie normalement. C'est la
// suivante qui lira l'état guéri.
export function rattraperEssai(userId, user) {
  if (!userId) return
  if (!aBesoinDeRattrapage(user)) return
  if (enVol.has(userId)) return
  enVol.add(userId)
  poserEssai(userId)
    .then((r) => {
      if (r.pose) console.log('[rattrapage-essai] essai démarré pour', userId, '· bienvenue :', r.bienvenue)
    })
    .catch((e) => console.warn('[rattrapage-essai]', userId, ':', e.message))
    .finally(() => { enVol.delete(userId) })
}

// Voie du passage quotidien : les comptes dormants, ceux qui ne se présentent
// pas. La sélection est le calque SQL de aBesoinDeRattrapage, à une garde près.
//
//   trial_started_at IS NONE   → la condition de fond.
//   subscription_status IS NONE
//   trial_status != 'converted' → on ne touche pas un compte payant.
//   bypass != true             → dégrossit le contournement ; isVip est
//                                réappliqué sur le record complet côté boucle,
//                                ce qui couvre AUSSI le propriétaire par
//                                adresse, dont le drapeau peut n'être pas posé.
//                                Même partage des rôles que purgeExpiredTrials.
//
// La porte armée n'est PAS une clause SQL : elle sort avant la requête. Sous
// INSCRIPTION_APPROBATION, cette étape ne lit même pas la base.
export async function rattraperEssaisDormants() {
  if (approbationRequise()) {
    return { total: 0, soignes: 0, bienvenues: 0, ignores: 0, arme: true, errors: [] }
  }
  let db
  let candidats = []
  try {
    db = await getDb()
    const r = await db.query(
      `SELECT id, email, bypass FROM user
       WHERE trial_started_at IS NONE
         AND subscription_status IS NONE
         AND trial_status != 'converted'
         AND bypass != true`
    )
    candidats = r?.[0] || []
  } catch (e) {
    console.warn('[rattrapage-essai] SELECT dormants échoué :', e.message)
    return { total: 0, soignes: 0, bienvenues: 0, ignores: 0, arme: false, errors: [{ stage: 'select', error: e.message }] }
  }

  let soignes = 0
  let bienvenues = 0
  let ignores = 0
  const errors = []
  // Séquentielle, comme les autres boucles du passage : on ne martèle pas la
  // base cloud, et la population est par construction minuscule.
  for (const c of candidats) {
    const uid = String(c.id || '').replace(/^user:/, '').replace(/^⟨+|⟩+$/g, '')
    if (isVip(c)) { ignores++; continue }
    try {
      const r = await poserEssai(uid)
      if (r.pose) soignes++
      else ignores++
      if (r.bienvenue === 'envoyee') bienvenues++
      if (r.bienvenue === 'echec') errors.push({ userId: uid, stage: 'mail', error: 'bienvenue non partie' })
    } catch (e) {
      console.warn('[rattrapage-essai] dormant', uid, ':', e.message)
      errors.push({ userId: uid, stage: 'update', error: e.message })
    }
  }
  return { total: candidats.length, soignes, bienvenues, ignores, arme: false, errors }
}
