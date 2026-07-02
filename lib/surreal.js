import { Surreal } from 'surrealdb'

let db = null
let connecting = null

export async function getDb(){
  // Ne réutiliser le singleton que si la WebSocket est vivante. Après épuisement
  // des reconnexions natives, .status reste 'disconnected' : on jette le singleton
  // mort et on reconstruit, au lieu de servir une connexion HS jusqu'au restart.
  if(db && db.status === 'connected') return db
  db = null
  if(connecting) return connecting

  connecting = (async () => {
    const instance = new Surreal()
    try {
      await instance.connect(process.env.SURREAL_URL, {
        namespace: process.env.SURREAL_NAMESPACE,
        database: process.env.SURREAL_DATABASE,
        authentication: {
          namespace: process.env.SURREAL_NAMESPACE,
          username: process.env.SURREAL_USER,
          password: process.env.SURREAL_PASS
        },
        // Reconnexion illimitée : la WebSocket se rétablit seule après toute
        // coupure (attempts:-1), l'auth ci-dessus étant réutilisée au reconnect.
        // retryDelay/retryDelayMax laissés aux valeurs par défaut du driver.
        reconnect: { enabled: true, attempts: -1 }
      })
      db = instance
      console.log('[surreal] Connecté à', process.env.SURREAL_URL)
      return instance
    } catch(err){
      connecting = null
      console.error('[surreal] Échec connexion:', err.message)
      throw err
    }
  })()

  return connecting
}

export async function close(){
  if(db){ await db.close(); db = null }
}
