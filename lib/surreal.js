import { Surreal } from 'surrealdb'

let db = null
let connecting = null

export async function getDb(){
  if(db) return db
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
        }
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
