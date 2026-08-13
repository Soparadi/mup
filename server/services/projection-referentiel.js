// Projection du référentiel mutualisé sur les listes privées de l'abonnée.
//
// CE QUE C'EST. Les enregistrements servis par /api/contacts et /api/pipeline sont
// ceux de l'abonnée, et rien d'autre. Ce que le référentiel mutualisé
// (referentiel_societes) sait de la même entreprise n'y est plus RECOPIÉ : il est
// JOINT à la lecture, en lot, sur la clé SIRET, et rendu dans un sous-objet dédié
// `referentiel`. Une valeur projetée reste donc toujours distinguable d'une valeur
// saisie — c'est le contrat de réponse qui les sépare, pas une convention de
// nommage qu'une page pourrait oublier.
//
// CE QUE CE N'EST PAS. Aucune écriture, dans aucun sens. Aucun repli par SIREN :
// le référentiel porte la maille ÉTABLISSEMENT, et deux établissements d'une même
// unité légale n'ont ni le même téléphone ni la même adresse — projeter le siège
// sur une agence serait afficher une coordonnée fausse sous une étiquette juste.
// Aucun rapprochement par nom et commune non plus. Un enregistrement sans SIRET
// canonique ne se projette pas ; la personne physique n'en porte pas, elle ne se
// projette donc jamais, et cette frontière tient par construction.
//
// FAIL-OPEN. Référentiel injoignable, user_plan illisible, n'importe quel échec :
// la liste repart NON PROJETÉE. Jamais une erreur — une liste de contacts ne
// devient pas inaccessible parce qu'une jointure d'agrément a échoué.
// L'opt-out, lui, reste fail-CLOSED par construction (checkBlocklistBatch rend
// tout le lot bloqué à l'échec). Les deux régimes se composent sans conflit :
// référentiel muet ou opposition supposée donnent le même résultat visible —
// rien de projeté.
//
// RÉGIME DÉCOMPTABLE, APPLIQUÉ ICI ET UNE SEULE FOIS. Email et téléphone sont les
// deux moyens de contact que l'abonnée paie : ils ne sont projetés que si le SIRET
// figure déjà dans user_plan.enrichedSirets. Site et réseaux sociaux ne sont pas
// décomptables et se projettent librement. C'est le même partage que celui tenu
// jusqu'ici par la fiche société et par la carte Pipeline, mais tenu côté serveur :
// une page qui l'oublierait ne peut plus rien révéler qui n'ait été payé.

import { getDb } from '../../lib/surreal.js'
import { normalizeSiret, hasEnriched } from '../config/plan-quotas.js'
import { getReferentielContactsBySirets } from './referentiel-read.js'
import { checkBlocklistBatch, checkBlocklistEmailsBatch } from './optout.js'

// Non décomptables : projetés sans condition de paiement.
const CHAMPS_LIBRES = ['website', 'societe_facebook', 'societe_instagram', 'societe_linkedin']
// Décomptables : projetés au seul SIRET déjà payé.
const CHAMPS_PAYANTS = ['societe_email', 'societe_tel']

// Le record user_plan de l'abonnée, ou null. Lecture seule, sans reset mensuel :
// on ne veut que enrichedSirets, qu'aucun reset ne touche. Échec → null, et
// hasEnriched(null, …) vaut false : le gate se ferme, il ne s'ouvre pas.
async function lireUserPlan(userId) {
  try {
    if (!userId) return null
    const db = await getDb()
    const r = await db.query('SELECT * FROM type::record("user_plan", $id)', { id: userId })
    return (r[0] || [])[0] || null
  } catch (e) {
    console.warn('[projection-referentiel] user_plan', String(e?.message || e).slice(0, 80))
    return null
  }
}

// Pose `referentiel` sur les enregistrements du lot qui portent un SIRET connu du
// référentiel. Mute et rend le tableau reçu (les enregistrements sortent de la
// requête, ils n'appartiennent à personne d'autre).
export async function projeterReferentiel(records, userId) {
  const liste = Array.isArray(records) ? records : []
  if (!liste.length) return liste
  try {
    // Un SIRET peut coiffer plusieurs enregistrements du lot (une société et une
    // carte pipeline du même établissement) : on garde la liste, pas le premier.
    const parSiret = new Map()
    for (const rec of liste) {
      const s = normalizeSiret(rec && rec.siret)
      if (!s) continue
      const l = parSiret.get(s)
      if (l) l.push(rec); else parSiret.set(s, [rec])
    }
    if (!parSiret.size) return liste

    const sirets = [...parSiret.keys()]
    const [champsParSiret, bloques, plan] = await Promise.all([
      getReferentielContactsBySirets(sirets),
      checkBlocklistBatch(sirets),
      lireUserPlan(userId)
    ])
    if (!champsParSiret.size) return liste

    // Second filtre opt-out — PAR ADRESSE, en un seul lot. Une opposition déposée
    // depuis un fournisseur grand public n'a ni siret_hash ni siren_hash : seule
    // l'adresse est connue, et c'est précisément l'adresse que la projection
    // révélerait. Comme aux routes d'enrichissement, l'adresse opposée retire la
    // fiche ENTIÈRE de la projection, pas seulement son email : l'abonnée ne doit
    // pas pouvoir déduire par quelle clé une fiche est opposée.
    const emails = [...champsParSiret.values()].map(c => c.societe_email).filter(Boolean)
    const emailsBloques = emails.length ? await checkBlocklistEmailsBatch(emails) : new Set()

    for (const [siret, champs] of champsParSiret) {
      if (bloques.has(siret)) continue
      if (champs.societe_email && emailsBloques.has(champs.societe_email)) continue
      const paye = hasEnriched(plan, siret)
      const projete = {}
      for (const k of CHAMPS_LIBRES) if (champs[k]) projete[k] = champs[k]
      if (paye) for (const k of CHAMPS_PAYANTS) if (champs[k]) projete[k] = champs[k]
      // Sous-objet vide : on ne le pose pas. Une clé `referentiel` présente veut
      // dire « le référentiel a quelque chose à dire sur ce SIRET ».
      if (!Object.keys(projete).length) continue
      for (const rec of parSiret.get(siret) || []) rec.referentiel = projete
    }
    return liste
  } catch (e) {
    console.warn('[projection-referentiel]', String(e?.message || e).slice(0, 80))
    return liste
  }
}

// La projection n'entre JAMAIS en base. Les pages renvoient l'enregistrement
// entier à l'enregistrement (PUT … CONTENT remplace le record) : sans ce retrait,
// le sous-objet servi en lecture serait recopié sur l'enregistrement privé au
// premier enregistrement venu — exactement la duplication que la projection
// supprime. Appelé par les quatre routes d'écriture contacts / pipeline.
export function retirerProjection(body) {
  if (body && typeof body === 'object') delete body.referentiel
  return body
}
