import { Surreal } from 'surrealdb'

const CONNECT_TIMEOUT_MS = 10000

let db = null
let connecting = null

export async function getDb(){
  // Ne réutiliser le singleton que si la WebSocket est vivante. Après épuisement
  // des reconnexions natives, .status reste 'disconnected' : on jette le singleton
  // mort et on reconstruit, au lieu de servir une connexion HS jusqu'au restart.
  if(db && db.status === 'connected') return db
  if(db){
    // Assainissement AVANT la sérialisation : sans remise à null de `connecting`,
    // le if() suivant resservirait la promesse du singleton mort. Le close() est
    // volontairement sans await — il marque l'instance #terminated, ce qui coupe
    // sa boucle de reconnexion, et on ne bloque pas l'appelant dessus.
    const old = db
    db = null
    connecting = null
    old.close().catch(() => {})
  }
  if(connecting) return connecting

  const attempt = (async () => {
    const instance = new Surreal()
    try {
      let to
      await Promise.race([
        instance.connect(process.env.SURREAL_URL, {
          namespace: process.env.SURREAL_NAMESPACE,
          database: process.env.SURREAL_DATABASE,
          authentication: {
            namespace: process.env.SURREAL_NAMESPACE,
            database: process.env.SURREAL_DATABASE,
            username: process.env.SURREAL_USER,
            password: process.env.SURREAL_PASS
          },
          // Reconnexion BORNÉE : la WebSocket se rétablit seule après une coupure
          // courte, mais n'insiste plus indéfiniment. Six tentatives (500 ms →
          // 8 s, ~23 s au total) puis l'instance retombe en 'disconnected' — état
          // que la garde .status ci-dessus détecte pour reconstruire un singleton
          // neuf, au lieu de rester collée à une socket qui ne reviendra pas.
          reconnect: { enabled: true, attempts: 6, retryDelay: 500, retryDelayMax: 8000 }
        }),
        new Promise((_, rej) => { to = setTimeout(() => rej(new Error('surreal connect timeout')), CONNECT_TIMEOUT_MS) })
      ])
      // Impératif : sans clearTimeout, le timer non consommé retient l'event loop
      // 10 s après CHAQUE connexion réussie.
      clearTimeout(to)
      db = instance
      console.log('[surreal] Connecté à', process.env.SURREAL_URL)
      return instance
    } catch(err){
      // L'instance perdue (timeout ou refus) garde sa propre boucle de
      // reconnexion : la fermer explicitement, sinon elle survit orpheline.
      instance.close().catch(() => {})
      console.error('[surreal] Échec connexion:', err.message)
      throw err
    }
  })()

  connecting = attempt
  // Nettoyage gardé par identité : une tentative périmée ne doit jamais effacer
  // le `connecting` d'une tentative plus récente. Le .catch() final ne sert qu'à
  // désamorcer la chaîne dérivée par .finally() — c'est `attempt` qui est rendu
  // à l'appelant, la chaîne n'a pas de consommateur et rejetterait dans le vide.
  attempt.finally(() => { if(connecting === attempt) connecting = null }).catch(() => {})

  return attempt
}

export async function close(){
  // connecting purgé AVANT l'await : une connexion en vol ne doit pas être
  // servie à un appelant après la demande de fermeture.
  connecting = null
  const old = db
  db = null
  if(old) await old.close()
}
