// Client Whereby Embedded — création d'une salle transitoire, appel UNIQUE.
// Une seule fonction exportée : creerSalle({ endDate }). Fail-safe strict :
// toute erreur (clé absente, réseau, HTTP, payload illisible) rend
// { created:false, reason }, JAMAIS de throw remontant — c'est l'appelante qui
// choisit le code de réponse. Le secret (WHEREBY_API_KEY) n'est JAMAIS loggé :
// il ne voyage que dans l'en-tête Authorization, qui n'est ni rendu ni écrit.
//
// Chaque appel abouti consomme une réunion du quota facturé du compte : la
// seule appelante prévue est une route authentifiée.

const ENDPOINT = 'https://api.whereby.dev/v1/meetings'

// Les quatre paramètres imposés à la création, non négociables par l'appelante :
//   isLocked        la salle est verrouillée — l'invité frappe, l'hôte admet ;
//   roomMode        « normal » plafonne la salle à quatre participants
//                   (référence REST). C'est la taille que le tableau de bord
//                   Whereby décrit comme pair-à-pair avec chiffrement de bout
//                   en bout ; la référence REST, elle, ne parle que de taille ;
//   roomNamePattern « uuid » — le nom de salle est un UUID nu. Aucun
//                   roomNamePrefix : cette URL part chez le prospect, elle ne
//                   doit rien dire de l'abonné qui l'envoie ni s'y deviner ;
//   fields          hostRoomUrl n'est rendu par Whereby que s'il est demandé,
//                   et sans lui l'abonné entrerait dans sa propre salle en
//                   invité, à frapper à sa porte.
const SALLE = {
  isLocked: true,
  roomMode: 'normal',
  roomNamePattern: 'uuid',
  fields: ['hostRoomUrl']
}

// { created:true, meetingId, roomUrl, hostRoomUrl, endDate } sur succès.
// Sinon { created:false, reason } — cinq motifs, que l'appelante distingue :
//   'requete'  date de fin absente : rien n'est envoyé ;
//   'config'   WHEREBY_API_KEY absente : repli net, aucun appel réseau, donc
//              aucun quota consommé ;
//   'amont'    Whereby a répondu non-2xx ; son code est joint en `status` ;
//   'reseau'   l'appel n'a pas abouti ;
//   'payload'  réponse 2xx sans URL de salle exploitable.
// La date de fin arrive telle que l'appelante l'a validée : ce module ne pose
// aucun défaut de durée, il transmet.
export async function creerSalle({ endDate } = {}) {
  const fin = String(endDate || '').trim()
  if (!fin) return { created: false, reason: 'requete' }
  const cle = process.env.WHEREBY_API_KEY
  if (!cle) return { created: false, reason: 'config' }

  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cle,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ...SALLE, endDate: fin })
    })
    if (!r.ok) {
      // Le corps amont nomme le champ refusé, et ne contient pas la clé — elle
      // n'a voyagé que dans l'en-tête. Tronqué à 200 caractères, comme ailleurs.
      const corps = await r.text().catch(() => '')
      console.warn('[whereby] création refusée', r.status, corps.slice(0, 200))
      return { created: false, reason: 'amont', status: r.status }
    }
    const data = await r.json()
    if (!data?.roomUrl) return { created: false, reason: 'payload' }
    return {
      created: true,
      meetingId: String(data.meetingId || ''),
      roomUrl: String(data.roomUrl),
      hostRoomUrl: String(data.hostRoomUrl || ''),
      // La date de fin effective est celle que Whereby confirme, pas celle
      // qu'on a demandée : c'est elle qui gouverne la mort de l'URL.
      endDate: String(data.endDate || fin)
    }
  } catch (e) {
    console.warn('[whereby]', String(e?.message || e).slice(0, 80))
    return { created: false, reason: 'reseau' }
  }
}
