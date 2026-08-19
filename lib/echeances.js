// Compteur d'échéances — le garde du cron.
//
// ─────────────────────────────────────────────────────────────────────────────
// RÉSERVE DE LECTURE — À LIRE AVANT DE SE FIER À CE CHIFFRE.
//
// Ce nombre NE DIT RIEN SEUL. Un `echeances_7j: 3` en face d'un `total: 0` est
// parfaitement normal : trois échéances viennent, aucune n'est due aujourd'hui.
// Ce chiffre ne parle QU'EN SÉRIE — une valeur qui reste stable jour après jour
// pendant que les envois restent à zéro. C'est cette forme-là, et elle seule,
// qui trahit une sélection qui ne ramasse plus (épreuve du 16 août 2026 : la
// requête n'avait pas échoué, elle avait réussi et rendu zéro ; aucun garde
// surveillant les exceptions n'aurait rien vu).
//
// PERSONNE NE LIT CE CHIFFRE AUJOURD'HUI. Il est écrit dans l'audit_log et il y
// attend. Qui le lira — écran d'exploitation, relevé périodique, alerte — est un
// chantier à part, non fait. Le prochain lecteur ne doit donc PAS prendre ce
// nombre pour une alerte : rien ici ne s'allume, rien n'avertit personne.
// ─────────────────────────────────────────────────────────────────────────────
//
// POURQUOI CE CHEMIN EST DISJOINT. Un garde qui emprunte la mécanique qu'il
// garde hérite de son bug : le 16 août, la sélection comparait un champ
// `datetime` à une borne liée en chaîne ISO, `>=` rendait toujours true et `<`
// toujours false. Un compteur écrit de la même façon aurait rendu la même
// absurdité. D'où la contrainte, qui n'est pas négociable : ARITHMÉTIQUE NATIVE
// SEULE (`time::now() + 7d`), AUCUNE BORNE LIÉE EN PARAMÈTRE.
//
// Ce que la clause `where` reçoit n'est donc jamais une donnée d'utilisateur :
// c'est une constante littérale déclarée dans le service, à côté de la sélection
// qu'elle surveille — pour qu'une retouche de la sélection ait son garde sous
// les yeux. Aucun appelant ne doit y interpoler quoi que ce soit de variable.
//
// FORME DE RETOUR, mesurée le 19/08/2026 contre movup-prod (surrealdb 3.2.4) :
//   — `SELECT count() ... GROUP ALL` rend `[[{ count: N }]]`, STABLE sur les
//     huit plans éprouvés (sans WHERE, prédicat indexé, balayage filtré,
//     arithmétique de durée) ;
//   — sur un ensemble VIDE il rend `[[{ count: 0 }]]`, JAMAIS un tableau vide —
//     c'est ce qui autorise le repli à 0 sans confondre avec « non mesuré » ;
//   — `SELECT VALUE count()` a été ÉCARTÉ : sa forme dépend du plan retenu
//     (scalaire sur balayage, objet sans WHERE ou sur prédicat indexé). Un index
//     posé plus tard sur `trial_ends_at` l'aurait fait basculer en silence, et le
//     compteur aurait lu 0 le jour où il devait parler. La lecture ci-dessous
//     accepte quand même les deux formes : ceinture, le moteur ayant montré
//     qu'il pouvait varier.
//
// -1 signifie NON MESURÉ (la requête de comptage a elle-même échoué). Jamais
// null, jamais un 0 ambigu.

import { getDb } from './surreal.js'

// LA FENÊTRE EST ÉCRITE EN DUR DANS CHAQUE CLAUSE (`time::now() + 7d`), pas dans
// une constante partagée : la clause est un fragment de SurrealQL, et une
// constante qu'on croirait pouvoir changer sans relire les huit clauses — ni le
// nom de clé `echeances_7j` qu'elles alimentent — mentirait sur son pouvoir.
// Changer la fenêtre, c'est changer les huit clauses ET le nom de la clé.
//
// etape — nom de l'étape gardée, pour que le warn dise laquelle a échoué.
// where — clause WHERE littérale, arithmétique native, sans paramètre lié.
export async function compterEcheances(etape, where) {
  try {
    const db = await getDb()
    const r = await db.query(`SELECT count() FROM user WHERE ${where} GROUP ALL`)
    const ligne = r?.[0]?.[0]
    const n = typeof ligne === 'number' ? ligne
      : (typeof ligne?.count === 'number' ? ligne.count : null)
    if (n === null) {
      console.warn(`[echeances] ${etape} : forme de retour inattendue —`, JSON.stringify(r))
      return -1
    }
    return n
  } catch (e) {
    console.warn(`[echeances] ${etape} échoué :`, e.message)
    return -1
  }
}
