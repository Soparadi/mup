// Position des cartes pipeline — la résolution d'une carte, et le balayage de
// celles que personne n'a jamais résolues.
//
// POURQUOI CE FICHIER EXISTE. `rattraperPositionCarte` vivait dans server.js,
// appelée par la seule route PUT /api/pipeline/:id. Le balayage quotidien a
// besoin des MÊMES deux voies, à la lettre : les dupliquer garantirait qu'elles
// divergent, et la garde de concordance d'adresse de la voie 1 comme le refus
// de géocoder une commune inconnue de la voie 2 sont précisément ce qu'une
// copie perdrait la première. La fonction est donc déplacée ici, telle quelle,
// et server.js l'importe. Son site d'appel dans la route ne change pas.
//
// Aucune dépendance à la portée de server.js : les trois briques employées
// (getDb, geocode, normText) viennent déjà de modules.
import { getDb } from '../../lib/surreal.js'
import { cleanRecordId } from '../../lib/db.js'
import { geocode } from './ban.js'
import { normText } from '../../lib/appariement.js'

// ── Rattrapage de position d'une carte pipeline ─────────────────────────────
// DÉFAUT VISÉ : pipeline.html:1627 efface lat/lng dès qu'une adresse est
// corrigée, en comptant sur la Carte pour les refaire au passage suivant. Une
// carte que personne n'ouvre dans la Carte reste donc sans position, et
// l'adresse rectifiée n'est jamais géocodée. Ce rattrapage rend la position au
// moment même où l'adresse est écrite, sans rien attendre de la Carte.
//
// FIRE-AND-FORGET, NO-THROW : appelée sans await après l'UPDATE, même régime
// que enrichReferentielActionnable et ponterCoordonneesSociete — tout échec
// avalé et journalisé, jamais de remontée dans la réponse de la route.
//
// DÉCLENCHEMENT : adresse écrite non vide ET couple lat/lng non exploitable
// dans le corps écrit. Volontairement PAS « l'adresse a changé » : les cartes
// visées n'ont jamais été géocodées et leur adresse ne bouge pas. La condition
// est auto-extinctive — une fois le couple écrit, la carte sort de la
// population et aucune sauvegarde ultérieure ne rappelle quoi que ce soit.
//
// LIMITE, et elle est réelle : une carte portant une position FAUSSE mais
// PRÉSENTE n'est pas réparée — la condition de déclenchement ne la voit pas.
// Réparer une position fausse supposerait de savoir qu'elle l'est, ce que rien
// n'établit au moment de l'écriture. Ce rattrapage traite l'absence, pas
// l'erreur.
//
// CE QU'ELLE REND, ET POURQUOI ELLE REND QUELQUE CHOSE. La route ignore ce
// retour, et continuera de l'ignorer : rien de son comportement ne change.
// C'est le balayage qui en a besoin — sans verdict, il ne pourrait pas dire
// combien de cartes il a positionnées, ni sur quelle voie, et son audit
// n'énoncerait qu'un nombre de tentatives. Le verdict ne décide de rien, il
// décrit ce qui vient d'avoir lieu.
//   { ecrit: true,  voie: 'referentiel' | 'ban' }
//   { ecrit: false, motif: 'sans-adresse' | 'deja-positionnee' | 'sans-siret'
//                        | 'commune-inconnue' | 'non-resolue' | 'erreur' }
export async function rattraperPositionCarte({ userId, id, corps }) {
  try {
    if (!userId || !id) return { ecrit: false, motif: 'sans-adresse' }
    const adresse = String(corps?.address || '').trim()
    if (!adresse) return { ecrit: false, motif: 'sans-adresse' }
    // Couple, jamais clé isolée : une seule des deux valeurs exploitable ne
    // fait pas une position. (0,0) écarté — null island n'est pas un lieu.
    const latEcrite = Number(corps?.lat)
    const lngEcrite = Number(corps?.lng)
    if (Number.isFinite(latEcrite) && Number.isFinite(lngEcrite) && (latEcrite !== 0 || lngEcrite !== 0)) {
      return { ecrit: false, motif: 'deja-positionnee' }
    }

    const siret = String(corps?.siret || '').replace(/\s+/g, '')
    if (!siret) return { ecrit: false, motif: 'sans-siret' }
    const db = await getDb()
    let lat = null
    let lng = null
    let voie = null

    // ── Voie 1 — referentiel_societes par SIRET, SOUS CONCORDANCE D'ADRESSE.
    // La garde de concordance n'est pas une précaution de style : sans elle,
    // une adresse que l'abonnée vient de corriger recevrait la coordonnée de
    // l'adresse qu'elle vient précisément de rejeter — soit l'annulation exacte
    // de l'effacement de pipeline.html:1627 que ce rattrapage sert. On ne
    // retient donc la coordonnée du référentiel que si l'adresse écrite est
    // bien la sienne, comparée en forme normalisée (casse, accents,
    // ponctuation, espaces) via normText.
    const ref = (await db.query(
      'SELECT adresse, lat, lng FROM referentiel_societes WHERE siret = $siret LIMIT 1',
      { siret }
    ))[0]?.[0]
    const latRef = Number(ref?.lat)
    const lngRef = Number(ref?.lng)
    const adresseRefNorm = normText(ref?.adresse)
    if (
      adresseRefNorm && adresseRefNorm === normText(adresse) &&
      Number.isFinite(latRef) && Number.isFinite(lngRef) && (latRef !== 0 || lngRef !== 0)
    ) {
      lat = latRef
      lng = lngRef
      voie = 'referentiel'
    }

    // ── Voie 2 — géocodage BAN, à défaut. Le code postal et la ville viennent
    // de `societes` (jointure userId + siret), l'adresse écrite servant de
    // voie. SANS CP NI VILLE TROUVÉS, LA VOIE 2 NE PART PAS : c'est
    // l'absence de ces deux-là qui a produit en production une position à
    // 706 km de la bonne — interrogée sur une voie seule, la BAN sert la
    // première homonyme de France. Rien n'est extrait par regex d'une saisie
    // libre : le CP et la ville sont lus dans leurs champs ou ne sont pas lus.
    //
    // CE QUE LA GARDE `codePostal && ville` FAIT VRAIMENT — à lire avant d'y
    // toucher. L'adresse portée par ces cartes est la forme AGRÉGÉE Etalab,
    // code postal et ville COMPRIS. La requête part donc redondante :
    // « 12 RUE DES FORGES 35270 COMBOURG 35270 COMBOURG ». Mesuré sur une
    // adresse divergente, la BAN l'encaisse sans broncher — bonne commune,
    // score 0,55, repli sur la voie la plus proche. La redondance n'est PAS
    // corrigée, et c'est délibéré : dédupliquer supposerait d'extraire CP et
    // ville d'une saisie libre, ce qu'on s'interdit précisément ici.
    //
    // D'où la lecture juste de la garde : elle ne vaut pas comme COMPLÉMENT
    // D'INFORMATION — la requête porte déjà le CP et la ville dans l'agrégat —
    // mais comme REFUS DE GÉOCODER UNE COMMUNE INCONNUE. Pas de ligne
    // `societes` avec zip et ville, pas de géocodage : c'est ce refus, et lui
    // seul, qui écarte le cas mesuré à 706 km, où l'adresse était TRONQUÉE et
    // la commune donc introuvable dans la chaîne envoyée. Constater que le CP
    // ajouté fait doublon et en conclure que la garde est superflue serait
    // l'erreur exacte à ne pas commettre : la retirer rouvre le défaut.
    if (lat === null) {
      const soc = (await db.query(
        'SELECT zip, ville FROM societes WHERE userId = $userId AND siret = $siret LIMIT 1',
        { userId, siret }
      ))[0]?.[0]
      const codePostal = String(soc?.zip || '').trim()
      const ville = String(soc?.ville || '').trim()
      if (!codePostal || !ville) return { ecrit: false, motif: 'commune-inconnue' }
      const pos = await geocode({ adresse, code_postal: codePostal, ville })
      const latBan = Number(pos?.lat)
      const lngBan = Number(pos?.lng)
      if (Number.isFinite(latBan) && Number.isFinite(lngBan) && (latBan !== 0 || lngBan !== 0)) {
        lat = latBan
        lng = lngBan
        voie = 'ban'
      }
    }

    // ── Rien de résolu → rien d'écrit. Aucun repli approximatif : ni centre de
    // ville, ni centre de département. Même doctrine que la Carte, qui préfère
    // l'absence de marqueur à un marqueur faux.
    if (lat === null || lng === null) return { ecrit: false, motif: 'non-resolue' }

    // SET, JAMAIS CONTENT : le PUT de la route remplace le record entier, et
    // 44 cartes sur 480 n'ont pas de created_at à réinjecter — un CONTENT
    // ici les amputerait. Le WHERE porte son propre userId : la garde de la
    // route protège le record de l'URL, pas celui qu'on va rejoindre (motif de
    // ponterCoordonneesSociete). Les deux clés sont posées ensemble, jamais
    // l'une sans l'autre. N'entraîne rien d'autre : ni enrichissement du
    // référentiel, ni pont vers contacts, ni geoStatus.
    await db.query(
      'UPDATE type::record("pipeline", $id) SET lat = $lat, lng = $lng WHERE userId = $userId',
      { id, lat, lng, userId }
    )
    return { ecrit: true, voie }
  } catch (e) {
    console.warn('[rattrapage-position]', String(e?.message || e).slice(0, 80))
    return { ecrit: false, motif: 'erreur' }
  }
}

// ── Balayage de la population sans position ─────────────────────────────────
// CE QUE LE RATTRAPAGE NE PEUT PAS FAIRE SEUL. Il ne part qu'à l'écriture d'une
// carte : une carte que personne ne sauvegarde n'est jamais rattrapée, et une
// carte dont l'adresse a été corrigée hier attend qu'on la rouvre. Relevé sur
// movup-prod avant d'écrire ces lignes : 8 cartes sans coordonnées sur 517,
// toutes avec adresse et SIRET, toutes résolubles par la voie 1, aucune jamais
// écrite (geoStatus vide sur les huit). Le balayage est le déclencheur qui
// manquait, et il ne demande rien à personne.
//
// UNE CARTE QUE LES DEUX VOIES NE RÉSOLVENT PAS EST LAISSÉE TELLE QUELLE, et
// représentée au passage suivant. Aucune marque n'est posée : une marque serait
// une écriture de plus sur la carte, elle appellerait sa propre règle
// d'effacement à la correction d'adresse — sans quoi une carte marquée
// resterait écartée après que sa commune est enfin connue — et elle ne ferait
// gagner que la relecture d'une population déjà bornée. Le coût d'un réessai
// est de deux SELECT, et la population ne grandit qu'au rythme des corrections
// d'adresse.
//
// CADENCE : une carte toutes les 350 ms. Ce n'est pas le volume qui l'exige,
// c'est la voie 2. Un balayage appelle geocode() en direct et passe donc À CÔTÉ
// du geocodeLimiter d'Express, qui ne protège que ce qui vient du navigateur.
// Une population où le référentiel ne répond pas martèlerait la BAN sans
// plafond. À 350 ms, un passage de mille cartes tient en six minutes.
//
// AUCUN PLAFOND DE CARTES PAR PASSAGE, et c'est délibéré : un plafond
// silencieux ferait passer une couverture partielle pour une couverture
// complète. C'est le booléen de non-réentrance, côté cron, qui empêche un
// passage long de chevaucher le tic suivant.
const CADENCE_BALAYAGE_MS = 350

function sommeil(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

// La même lecture que storedLatLng côté Carte : couple fini, null-island
// exclue. C'est elle qui définit la population, et elle doit dire exactement ce
// que la Carte dit, sans quoi le balayage travaillerait sur d'autres cartes que
// celles qui apparaissent sans marqueur.
function positionExploitable(r) {
  const lat = Number(r?.lat)
  const lng = Number(r?.lng)
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
}

export async function balayerPositionsCartes() {
  const motifs = {}
  let population = 0
  let resolues = 0
  let erreurs = 0
  try {
    const db = await getDb()
    // Projection de six champs, jamais SELECT * : l'instance est petite, et un
    // balayage n'a aucune raison de ramener les notes et l'historique de
    // chaque carte pour lire deux flottants.
    const rows = (await db.query('SELECT id, userId, address, siret, lat, lng FROM pipeline'))[0] || []
    // Sans adresse, aucune des deux voies n'a de quoi partir : la carte n'entre
    // pas dans la population, et son absence de position n'est pas un échec.
    const cible = rows.filter(function (r) {
      return !positionExploitable(r) && String(r?.address || '').trim()
    })
    population = cible.length

    for (let i = 0; i < cible.length; i++) {
      const r = cible[i]
      // L'id vient de la base et non d'une URL : il porte son préfixe de table,
      // que type::record refuserait. Même idiome que ponterAdresseVersDevis.
      const brut = String(r.id)
      const id = cleanRecordId('pipeline', brut) || brut
      const verdict = await rattraperPositionCarte({
        userId: String(r.userId || ''),
        id,
        corps: { address: r.address, siret: r.siret, lat: r.lat, lng: r.lng }
      })
      const cle = verdict?.ecrit ? ('ecrit:' + verdict.voie) : (verdict?.motif || 'inconnu')
      motifs[cle] = (motifs[cle] || 0) + 1
      if (verdict?.ecrit) resolues++
      // SEULE L'EXCEPTION COMPTE POUR UNE ERREUR. Une carte non résolue est
      // l'issue normale du dispositif — commune inconnue, référentiel muet,
      // BAN sans réponse — et la compter comme erreur ferait rendre au cron un
      // état malade chaque fois qu'il travaille correctement sur une carte
      // qu'on ne sait pas situer.
      if (verdict?.motif === 'erreur') erreurs++
      if (i < cible.length - 1) await sommeil(CADENCE_BALAYAGE_MS)
    }
  } catch (e) {
    // La clé `error` est ce que estOk lit pour déclarer l'étape en échec.
    return { population, resolues, erreurs: erreurs + 1, motifs, error: String(e?.message || e).slice(0, 120) }
  }
  return { population, resolues, restantes: population - resolues, erreurs, motifs }
}
