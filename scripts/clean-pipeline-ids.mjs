import 'dotenv/config'
import { getDb } from '../lib/surreal.js'

const db = await getDb()
const all = await db.query('SELECT id FROM pipeline')
const records = all[0] || []
console.log(`Found ${records.length} pipeline records:`)
records.forEach(r => console.log('  -', String(r.id)))

const corrupted = records.filter(r => {
  const s = String(r.id)
  return s.indexOf('\u27e8') !== -1 || s.indexOf('\u27e9') !== -1
})
console.log(`\n${corrupted.length} corrupted records to delete:`)
corrupted.forEach(r => console.log('  -', String(r.id)))

if (corrupted.length === 0) {
  console.log('Nothing to clean.')
  process.exit(0)
}

console.log('\nDeleting (with RETURN BEFORE for confirmation)...')
let total = 0
for (const rec of corrupted) {
  try {
    const result = await db.query('DELETE $id RETURN BEFORE', { id: rec.id })
    const arr = result[0] || []
    if (arr.length > 0) {
      console.log('  ✓ deleted', String(rec.id))
      total++
    } else {
      console.log('  ✗ no match', String(rec.id))
    }
  } catch (e) {
    console.error('  ✗ error', String(rec.id), e.message)
  }
}

console.log(`\nDone. ${total}/${corrupted.length} effectively deleted.`)
process.exit(0)
