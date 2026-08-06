// Dernière venue d'un compte — champ `last_seen_at` sur `user`.
//
// POURQUOI. L'inventaire des comptes distingue aujourd'hui l'abonné payant de
// l'abonné en essai, mais pas l'abonné qui revient consulter son pipeline de
// l'abonné qui a cessé de venir. Les deux affichent le même statut et le même
// plan pendant des mois. `last_seen_at` est la seule donnée qui les sépare.
//
// CE QUE CE N'EST PAS. Ni un compteur de visites (le décompte par compte se
// dérive déjà de `lead_search` et des tables de travail — un champ `visites` sur
// `user` ferait doublon avec une source plus fine), ni la mesure d'audience du
// site public (server/services/visites.js, visiteurs anonymes, aucun lien avec
// `user`). Une date, rien d'autre.
//
// LE PAS D'UNE HEURE. Écrire à chaque requête authentifiée coûterait un UPDATE
// par appel d'API, soit des dizaines par minute et par abonné actif, pour une
// donnée dont personne ne lit la minute. Le pas est tenu par une carte en
// mémoire du process : au redémarrage elle est vide, la première requête de
// chaque compte réécrit une fois, et c'est tout ce que coûte l'oubli.
//
// JAMAIS BLOQUANT. L'appel ne rend aucune promesse à attendre : l'UPDATE part
// en arrière-plan et son échec se solde par un warn. Le portillon
// d'authentification ne doit pas dépendre de la réussite d'une écriture qui
// n'intéresse que le tableau superadmin.

import { getDb } from '../../lib/surreal.js'

const PAS_MS = 60 * 60 * 1000
const CARTE_MAX = 5000

const derniereEcriture = new Map()

export function toucherLastSeen(userId) {
  if (!userId) return
  const maintenant = Date.now()
  const precedent = derniereEcriture.get(userId)
  if (precedent && maintenant - precedent < PAS_MS) return
  derniereEcriture.set(userId, maintenant)

  // Borne mémoire : au-delà du plafond, on oublie les entrées les plus
  // anciennes (Map itère dans l'ordre d'insertion). Un compte oublié se paie
  // d'un UPDATE de trop, pas d'une fuite.
  if (derniereEcriture.size > CARTE_MAX) {
    const trop = derniereEcriture.size - CARTE_MAX
    let n = 0
    for (const cle of derniereEcriture.keys()) {
      if (n++ >= trop) break
      derniereEcriture.delete(cle)
    }
  }

  getDb()
    .then((db) => db.query('UPDATE type::record("user", $id) SET last_seen_at = time::now()', { id: userId }))
    .catch((e) => console.warn('[last-seen]', e.message))
}
