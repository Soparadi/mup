// Contrat de champs d'une PERSONNE (face personne d'un record `contacts`).
//
// MODÈLE A — records liés : chaque personne est un record de la table `contacts`
// relié à sa société via `societe_id`. Il n'y a PAS de tableau `personnes[]`
// embarqué dans un autre record ; la liste des personnes d'une société se
// reconstruit en lisant les contacts qui partagent le même `societe_id`.
//
// IMPORTANT — distinction des deux « noms », à ne jamais confondre :
//   nom           → RAISON SOCIALE de la société (face société du record).
//                   NE JAMAIS l'écraser avec le patronyme de la personne.
//   nom_personne  → PATRONYME (nom de famille) de la personne SEUL. Champ
//                   distinct de `nom`, ajouté par la brique A.
//   contact_nom   → « Prénom Nom » complet de la personne (champ historique,
//                   conservé tel quel pour compat ; reste alimenté en parallèle).
//
// Tous les champs ci-dessous sont ADDITIFS et la base est SCHEMALESS : aucune
// migration n'est requise. Cette fonction se contente de garantir leur présence
// (avec des valeurs vides par défaut) et de tenir synchronisés les couples
// liste/valeur-unique (emails[]/email et telephones[]/phone) pour la compat.

// Liste de référence des champs propres à la face personne (hors champs société
// et hors champs techniques : nom, societe_id, statut, source, userId, etc.).
export const PERSON_FIELDS = [
  'civilite',               // "M." | "Mme" | ""
  'prenom',                 // prénom (champ historique conservé)
  'nom_personne',           // NOUVEAU — patronyme seul, distinct de `nom` (raison sociale)
  'contact_nom',            // legacy — "Prénom Nom" complet
  'poste',                  // fonction
  'anniversaire',           // NOUVEAU — texte libre "JJ/MM" ou "JJ/MM/AAAA", optionnel
  'emails',                 // NOUVEAU — string[] (plusieurs emails)
  'email',                  // compat — 1er email de emails[]
  'telephones',             // NOUVEAU — string[] (plusieurs téléphones)
  'phone',                  // compat — 1er téléphone de telephones[]
  'linkedin',               // profil LinkedIn de la personne (champ historique)
  'instagram_perso',        // NOUVEAU — Instagram de la personne (distinct de l'Instagram société)
  'facebook_perso',         // NOUVEAU — Facebook de la personne (distinct du Facebook société)
  'note_personne',          // NOUVEAU — note libre propre à cette personne
  'rgpd_consent_personne'   // NOUVEAU — booléen, consentement RGPD propre à CETTE personne
]

function cleanList(value, fallback) {
  let arr = Array.isArray(value) ? value : []
  arr = arr.map(s => String(s == null ? '' : s).trim()).filter(Boolean)
  if (!arr.length && typeof fallback === 'string' && fallback.trim()) {
    arr = [fallback.trim()]
  }
  return [...new Set(arr)] // dédoublonnage en conservant l'ordre
}

// Normalise la face personne d'un record contact, de façon ADDITIVE et NON
// destructive : ne touche jamais aux champs société (nom, adresse, website, …)
// ni aux champs techniques. Retourne une copie complète du record.
export function normalizePersonFields(rec) {
  const r = { ...(rec || {}) }

  // Civilité
  if (typeof r.civilite !== 'string') r.civilite = ''

  // Identité personne
  if (typeof r.prenom !== 'string') r.prenom = ''
  if (typeof r.nom_personne !== 'string') r.nom_personne = ''
  if (typeof r.contact_nom !== 'string') r.contact_nom = ''
  if (typeof r.poste !== 'string') r.poste = ''
  if (typeof r.anniversaire !== 'string') r.anniversaire = ''

  // Emails multiples : emails[] canonique, email = 1er (compat ascendante).
  const emails = cleanList(r.emails, r.email)
  r.emails = emails
  r.email = emails[0] || ''

  // Téléphones multiples : telephones[] canonique, phone = 1er (compat).
  const telephones = cleanList(r.telephones, r.phone)
  r.telephones = telephones
  r.phone = telephones[0] || ''

  // Réseaux de la personne
  if (typeof r.linkedin !== 'string') r.linkedin = ''
  if (typeof r.instagram_perso !== 'string') r.instagram_perso = ''
  if (typeof r.facebook_perso !== 'string') r.facebook_perso = ''

  // Note + consentement RGPD propres à la personne
  if (typeof r.note_personne !== 'string') r.note_personne = ''
  r.rgpd_consent_personne = !!r.rgpd_consent_personne

  return r
}
