// Approbation manuelle des inscriptions — la porte, et son unique commande.
//
// Le produit est en développement : personne n'obtient d'essai sans accord
// explicite. Ce module dit QUI est en attente ; il ne bloque rien lui-même.
// Ses appelants (deriveAppState, le portillon des pages app, le parcours
// d'inscription) posent chacun leur garde sur estEnAttente.
//
// UNE SEULE COMMANDE : la variable d'environnement INSCRIPTION_APPROBATION.
// Absente, vide, ou toute autre valeur que '1' : estEnAttente rend false pour
// tout le monde, et chaque garde de l'application devient un retour anticipé.
// Le parcours d'inscription redevient alors exactement ce qu'il était, sans
// commit et sans déploiement. Convention '1' reprise d'ENABLE_DEV_RESET
// (server.js), la seule autre porte de ce dépôt commandée par variable.
//
// Spec : fonctions pures. Aucun I/O, aucun accès req/res, aucune écriture DB.
// La lecture de process.env est faite à CHAQUE appel, jamais mise en cache au
// chargement du module : une variable changée dans Railway redémarre l'instance,
// mais on ne veut pas que la réversibilité dépende de cet ordre-là.

import { isVip } from './vip.js'

export function approbationRequise() {
  return process.env.INSCRIPTION_APPROBATION === '1'
}

// Un compte est en attente quand les quatre conditions tiennent ensemble.
//
// `requise` est injectable pour les tests ; en service, elle vaut la lecture
// de la variable. C'est le seul paramètre qui rend cette fonction impure, et
// il est isolé ici pour que deriveAppState reste testable sans environnement.
//
// isVip : le propriétaire et les comptes VIP ne passent jamais par cette
// porte. Ils ne peuvent donc pas se verrouiller dehors avec la variable.
//
// trial_started_at : SÛRETÉ INDÉPENDANTE DU SCRIPT. Un compte dont l'essai a
// déjà démarré a, par définition, été admis avant que cette porte existe.
// Cette condition seule met les comptes antérieurs hors d'atteinte, que le
// script d'approbation rétroactive ait été lancé ou non. Elle est CONSERVÉE
// après le script : elle ne coûte rien et couvre l'ordre de déploiement.
//
// Elle a une conséquence assumée, côté interrupteur superadmin : refermer
// l'approbation d'un compte dont l'essai a démarré ne le remet PAS en attente.
// Un essai démarré ne se rembobine pas. Le sens « fermé » de l'interrupteur
// n'annule qu'une approbation donnée par erreur, avant tout démarrage.
export function estEnAttente(user, requise = approbationRequise()) {
  if (!requise) return false
  if (!user) return false
  if (isVip(user)) return false
  if (user.approved_at) return false
  if (user.trial_started_at) return false
  return true
}
