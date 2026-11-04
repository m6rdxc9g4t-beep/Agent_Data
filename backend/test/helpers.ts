import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatasetDb } from '../src/db.js'
import { importFile } from '../src/importer.js'
import { computeProfile } from '../src/profile.js'
import { Store } from '../src/store.js'

export const SAMPLES = new URL('../../sample_data/', import.meta.url).pathname

export async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'datamind-'))
  const store = new Store(dir)
  await store.init()
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export async function loadSample(file: 'ventes.csv' | 'demo_complet.csv') {
  const { store, cleanup } = await tempStore()
  const meta = await importFile(store, join(SAMPLES, file), file)
  const db = await DatasetDb.open(store.parquetPath(meta.id))
  const profile = await computeProfile(db)
  return { store, meta, db, profile, cleanup: async () => { db.close(); await cleanup() } }
}

export async function importText(store: Store, name: string, content: string | Buffer) {
  const path = join(store.root, 'tmp', name)
  await writeFile(path, content)
  return importFile(store, path, name)
}
