// Resolution order for userId, designed to swap in real auth later:
//   1. req.session?.userId  (TODO: when auth middleware lands)
//   2. req.headers['x-user-id']
//   3. req.query.userId
//   4. req.body?.userId
//   5. process.env.MUP_DEFAULT_USER_ID
//   6. literal 'default'
export function getUserId(req) {
  return (
    req?.session?.userId ||
    req?.headers?.['x-user-id'] ||
    req?.query?.userId ||
    req?.body?.userId ||
    process.env.MUP_DEFAULT_USER_ID ||
    'default'
  )
}

// Strict variant: returns null + sends 401 if no userId resolvable.
// In V1 with env fallback, this never 401s. Stays dormant until auth lands.
export function requireUserId(req, res) {
  const userId = getUserId(req)
  if (!userId) {
    res.status(401).json({ error: 'Authentification requise' })
    return null
  }
  return String(userId)
}
