/**
 * Embeds Cosmo's kaizen practice — the learning log and the curated exemplars —
 * into the shared Upstash Vector index, tagged role:'kaizen'.
 *
 * The index is shared with the wisdom corpus, which opencosmos-ai/knowledge
 * writes under the `knowledge/` prefix. Both writers reconcile only the IDs
 * they own, so neither can delete the other's work. That guard is the reason
 * the corpus survived leaving the monorepo; do not loosen it.
 *
 * rag.ts filters on role:'kaizen' and renders these under "Your Learning Log"
 * rather than "Retrieved Passages", so they shape how Cosmo conducts itself
 * without ever entering the citation path.
 *
 * Chunks carry a content hash, so an unchanged practice costs zero writes
 * against Upstash's daily ceiling.
 *
 *   npm run embed        write
 *   npm run embed:dry    plan only, no writes
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import matter from 'gray-matter'
import { Index } from '@upstash/vector'
import { resolveDomainForTradition } from './tradition-domain.js'

// ─── Path setup + .env loading ────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
// One level up, not two: this script lives at scripts/, where the monorepo's
// copy lived at scripts/knowledge/. Getting this wrong resolves the practice to
// a directory that does not exist, which finds nothing and reports success.
const ROOT_DIR = resolve(__dirname, '..')
const KAIZEN_DIR = resolve(ROOT_DIR, 'kaizen')

// Which chunk-ID prefixes this repository is responsible for. The stale-ID
// sync deletes only within these; anything else belongs to another writer.
// This repository owns ONLY Cosmo's kaizen vectors. The corpus is written by
// opencosmos-ai/knowledge, which owns the `knowledge/` prefix.
//
// Narrowed ahead of removing knowledge/ from this repository, because the guard
// would otherwise turn against the very thing it was added to protect: with
// 'knowledge/' still claimed here, the first run after that deletion would
// produce no corpus chunks, find ~4,600 knowledge/ vectors it believed it owned
// and no longer generated, and delete every one — silently, exit code 0.
// This repository owns Cosmo's kaizen vectors and nothing else — the wisdom
// corpus is written by opencosmos-ai/knowledge under the `knowledge/` prefix
// and must survive every run here untouched.
//
// Two prefixes, not one. Chunks are emitted under `kaizen/`, because that is
// where the practice now lives. `packages/ai/kaizen/` is the address it had
// inside the monorepo: claiming it here lets one run reconcile those stale
// vectors away rather than leaving Cosmo's log duplicated in the index. It can
// be dropped once the monorepo's embedder is gone and a run reports 0 stale.
const OWNED_PREFIXES = ['kaizen/', 'packages/ai/kaizen/'] as const

function loadEnv(envPath: string) {
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*"?(.+?)"?\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

loadEnv(join(ROOT_DIR, 'apps', 'web', '.env'))
loadEnv(join(ROOT_DIR, 'apps', 'web', '.env.local'))

// ─── Types ───────────────────────────────────────────────────────────────────

type ChunkMetadata = {
  source: string           // relative path from repo root, e.g. knowledge/sources/foo.md
  heading: string          // H2/H3/H4 heading text, or 'intro' for pre-heading content
  parent_heading?: string  // immediate ancestor (H2 for H3 chunks; nearest H3 — or H2 — for H4 chunks)
  title: string
  domain: string
  role: string
  tags: string[]
  audience: string[]
  text: string             // the passage text (without context prefix) — shown to Cosmo in RAG context
  author?: string
  tradition?: string
  wiki_path?: string       // set for wiki pages only
  content_hash?: string    // sha256 of `data`, 16 hex — lets a run skip unchanged chunks

  // Quote-specific (set only when chunk_type === 'quote')
  chunk_type?: 'quote'
  quote_id?: string                  // canonical id, e.g. "q_0159"
  category?: string
  provenance_status?: string         // verified | attributed | …
  provenance_confidence?: number     // 0.0–1.0
  source_work?: string
  source_section?: string
}

type VectorChunk = {
  id: string
  data: string        // enriched text passed to Upstash for embedding generation
  metadata: ChunkMetadata
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Short, deterministic hash of a section's first 200 chars. Used as a slug
// disambiguator when multiple sections within a file share the same heading
// (e.g. seven poems titled "Thought" in Leaves of Grass). Stable across runs
// and across insertions elsewhere in the file — only flips if the section's
// own opening text is edited.
function shortHash(text: string): string {
  return createHash('sha1').update(text.slice(0, 200)).digest('hex').slice(0, 8)
}

function lastParagraph(text: string): string {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  return paras.length > 0 ? paras[paras.length - 1] : ''
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Split markdown body at H2/H3/H4 heading boundaries with 1-paragraph overlap.
 *
 * Recognises:
 *   1. Markdown H2:    ## Heading Text             → primary chunk boundary
 *   2. Markdown H3:    ### Heading Text            → secondary chunk boundary (nested under H2)
 *   3. Markdown H4:    #### Heading Text           → tertiary boundary (nested under nearest H3,
 *                                                     falling back to H2 if no H3 is in scope)
 *   4. CHAPTER:        CHAPTER I. Title / CHAPTER 1 / CHAPTER I
 *
 * Nested sections record their immediate parent so the embedding context can
 * include the most informative ancestor (e.g. "Song of Myself > 1" for an H4
 * verse, not "Leaves of Grass > 1"). This matters for works like Leaves of
 * Grass where the Book → Poem → Verse hierarchy is three levels deep and the
 * Poem (H3) is more semantically relevant than the Book (H2).
 *
 * Docs with only H2 headings behave identically to the previous chunker.
 *
 * The overlap prepends the last paragraph of the preceding section onto the
 * next chunk, improving retrieval for questions that straddle boundaries.
 */
function chunkAtHeadings(body: string): Array<{ heading: string; parentHeading?: string; text: string }> {
  const lines = body.split('\n')

  type RawSection = {
    heading: string
    parentHeading?: string
    rawLines: string[]
  }

  const sections: RawSection[] = []
  let currentHeading = 'intro'
  let currentParent: string | undefined = undefined
  let currentLines: string[] = []
  let lastH2Heading: string | undefined = undefined  // most recent H2 (resets H3 scope)
  let lastH3Heading: string | undefined = undefined  // most recent H3 (resets when new H2 is seen)

  // Matches:  ## Heading
  const markdownH2 = /^## (.+)$/
  // Matches:  ### Heading
  const markdownH3 = /^### (.+)$/
  // Matches:  #### Heading
  const markdownH4 = /^#### (.+)$/
  // Matches:  CHAPTER I.  /  CHAPTER IV  /  CHAPTER 3. Some Title
  const chapterHeading = /^(CHAPTER\s+[IVXLCDM\d]+\.?\s*.*)$/i

  for (const line of lines) {
    const h2Match = line.match(markdownH2)
    const h3Match = !h2Match ? line.match(markdownH3) : null
    const h4Match = !h2Match && !h3Match ? line.match(markdownH4) : null
    const chapterMatch = !h2Match && !h3Match && !h4Match ? line.match(chapterHeading) : null

    if (h2Match || chapterMatch) {
      sections.push({ heading: currentHeading, parentHeading: currentParent, rawLines: currentLines })
      const newHeading = (h2Match?.[1] ?? chapterMatch?.[1])!.trim()
      lastH2Heading = newHeading
      lastH3Heading = undefined  // H3 scope resets at every H2
      currentHeading = newHeading
      currentParent = undefined  // H2 has no parent
      currentLines = []
    } else if (h3Match) {
      sections.push({ heading: currentHeading, parentHeading: currentParent, rawLines: currentLines })
      const newHeading = h3Match[1].trim()
      lastH3Heading = newHeading
      currentHeading = newHeading
      currentParent = lastH2Heading  // H3 nests under the most recent H2
      currentLines = []
    } else if (h4Match) {
      sections.push({ heading: currentHeading, parentHeading: currentParent, rawLines: currentLines })
      currentHeading = h4Match[1].trim()
      // H4 prefers its nearest H3 ancestor (more specific). Falls back to H2
      // when the H4 appears outside any H3 scope.
      currentParent = lastH3Heading ?? lastH2Heading
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  sections.push({ heading: currentHeading, parentHeading: currentParent, rawLines: currentLines })

  // Drop sections that are entirely empty
  const nonEmpty = sections.filter(s => s.rawLines.join('').trim().length > 0)

  return nonEmpty.map((section, idx) => {
    let text = section.rawLines.join('\n').trim()
    if (idx > 0 && text) {
      const prevText = nonEmpty[idx - 1].rawLines.join('\n').trim()
      const overlap = lastParagraph(prevText)
      if (overlap) text = `${overlap}\n\n${text}`
    }
    return { heading: section.heading, parentHeading: section.parentHeading, text }
  })
}

// ─── File discovery ───────────────────────────────────────────────────────────

// Skip meta-files that aren't knowledge content.
// LESSONS.md is the always-injected Operating Lessons digest (it's in Cosmo's
// context every turn already), so indexing it would only duplicate tokens.
const SKIP_FILES = new Set(['index.md', 'log.md', 'README.md', 'LESSONS.md'])

// Never descended into. `scripts/` holds this embedder itself; node_modules
// would put every dependency README into Cosmo's learning log.
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'scripts'])

/**
 * The kaizen files, or an error. Never an empty list: an empty practice is a
 * broken checkout or a mis-resolved path, and both look exactly like success if
 * you let them through — the dry run would report 0 chunks and a live run would
 * reconcile Cosmo's entire learning log out of the index.
 */
function findKaizenFiles(): string[] {
  const files = existsSync(KAIZEN_DIR) ? walkMd(KAIZEN_DIR) : []
  if (files.length === 0) {
    throw new Error(`no kaizen files under ${KAIZEN_DIR} — refusing to embed an empty practice`)
  }
  return files
}

function walkMd(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      results.push(...walkMd(full))
    } else if (entry.endsWith('.md') && !SKIP_FILES.has(entry)) {
      results.push(full)
    }
  }
  return results
}

// ─── Chunk builder ────────────────────────────────────────────────────────────

function buildChunks(filePath: string): VectorChunk[] {
  const raw = readFileSync(filePath, 'utf-8')

  let fm: Record<string, unknown> = {}
  let content = ''
  try {
    const parsed = matter(raw)
    fm = parsed.data as Record<string, unknown>
    content = parsed.content
  } catch (err) {
    const rel = relative(ROOT_DIR, filePath)
    console.warn(`  ⚠️  Skipping ${rel} — YAML frontmatter parse error: ${(err as Error).message.split('\n')[0]}`)
    return []
  }

  if (!content.trim()) return []

  const relPath = relative(ROOT_DIR, filePath)
  const isWiki = relPath.startsWith('knowledge/wiki/')

  const title: string = fm.title ?? relPath
  const role: string = fm.role ?? 'source'
  const author: string | undefined = fm.author
  const tradition: string | undefined = fm.tradition
  const tags: string[] = Array.isArray(fm.tags) ? fm.tags : []
  const audience: string[] = Array.isArray(fm.audience) ? fm.audience : []
  // Domain is derived from tradition via the shared config (the source-file
  // `domain:` frontmatter field has been retired; tradition is the single
  // source of truth for placement in the constellation hierarchy). Wiki
  // pages don't always have a `tradition:` field and may carry their own
  // `domain:`, so honor that fallback for wiki only.
  const domain: string = tradition
    ? resolveDomainForTradition(tradition)
    : (isWiki && typeof fm.domain === 'string' ? fm.domain : 'uncategorized')

  // Context prefix improves embedding relevance by grounding each chunk in its source
  const contextLines = [
    `Title: ${title}`,
    author ? `Author: ${author}` : null,
    `Domain: ${domain}`,
    tradition ? `Tradition: ${tradition}` : null,
    fm.summary ? `Summary: ${fm.summary}` : null,
  ].filter(Boolean) as string[]
  const contextPrefix = contextLines.join('\n')

  const sections = chunkAtHeadings(content)

  // Upstash limits: 48KB per metadata object, 1MB per `data` string.
  // Spec target: 200–800 tokens per chunk (~800–3200 chars).
  // We cap data at 3000 chars (embedding input) and stored text at 2000 chars
  // (what Cosmo reads in the context window). Large sections are truncated at
  // these boundaries — the embedding still captures the semantic substance.
  const DATA_TEXT_LIMIT = 3000
  const METADATA_TEXT_LIMIT = 2000

  const filteredSections = sections.filter(s => s.text.length > 80) // skip trivially short chunks

  // First pass: count slug occurrences within this file. Slugs that collide
  // get a content-hash disambiguator; unique slugs stay clean to match the
  // citation format documented in docs/pm.md (Phase 8).
  const slugCounts = new Map<string, number>()
  for (const s of filteredSections) {
    const slug = slugify(s.heading)
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1)
  }

  return filteredSections.map(s => {
    const headingSlug = slugify(s.heading)
    const collides = (slugCounts.get(headingSlug) ?? 0) > 1
    // Most chunks: `path#slug` (stable, citation-friendly).
    // Colliding chunks: `path#slug-<hash>` — hash derives from the section's
    // own opening text, so inserting another section elsewhere in the file
    // does not shift this chunk's ID.
    const id = collides
      ? `${relPath}#${headingSlug}-${shortHash(s.text)}`
      : `${relPath}#${headingSlug}`

    // Section label for embedding: "Book II > Chapter III" for nested, "Chapter III" for flat
    const sectionLabel = s.parentHeading
      ? `${s.parentHeading} > ${s.heading}`
      : s.heading

    // data = enriched text passed to Upstash for embedding generation
    // metadata.text = passage shown to Cosmo in the RAG context window
    const truncatedForData = s.text.length > DATA_TEXT_LIMIT
      ? s.text.slice(0, DATA_TEXT_LIMIT) + '…'
      : s.text
    const data = `${contextPrefix}\n\nSection: ${sectionLabel}\n\n${truncatedForData}`

    const storedText = s.text.length > METADATA_TEXT_LIMIT
      ? s.text.slice(0, METADATA_TEXT_LIMIT) + '…'
      : s.text

    const metadata: ChunkMetadata = {
      source: relPath,
      heading: s.heading,
      title,
      domain,
      role,
      tags,
      audience,
      text: storedText,
    }
    if (s.parentHeading) metadata.parent_heading = s.parentHeading
    if (author) metadata.author = author
    if (tradition) metadata.tradition = tradition
    if (isWiki) metadata.wiki_path = relPath

    return { id, data, metadata }
  })
}

// ─── Kaizen chunk builder ─────────────────────────────────────────────────────

/**
 * Kaizen files (packages/ai/kaizen) — the feedback/notes.md learning log and any
 * exemplars — are chunked exactly like corpus docs, then tagged role:'kaizen' so
 * rag.ts renders them under "Your Learning Log" instead of "Retrieved Passages".
 * This keeps Cosmo's own incident log and exemplars out of the wisdom-corpus
 * citation path while still making them semantically retrievable for recall.
 */
function buildKaizenChunks(filePath: string): VectorChunk[] {
  const chunks = buildChunks(filePath)
  const rel = relative(ROOT_DIR, filePath)
  const isExemplar = rel.includes(`${'/'}exemplars${'/'}`)
  const title = isExemplar ? 'Cosmo Exemplar' : 'Cosmo Learning Log'
  // Embedding enrichment: the raw entries read as topic-specific incidents (e.g.
  // "fabricated web access"), so a generic recall query like "what have you
  // learned recently?" wouldn't surface them. Prepending a kaizen-meta line to
  // the EMBEDDING input (data) — not the displayed text — lets those meta-queries
  // match, without changing what Cosmo actually reads.
  const metaCue = isExemplar
    ? 'Cosmo kaizen exemplar — a model example of Cosmo at its best, curated for continuous improvement.'
    : 'Cosmo kaizen learning log — a record of recent learnings, lessons learned from experience, anti-patterns noticed, and how Cosmo has grown over time (continuous improvement / 改善).'
  for (const c of chunks) {
    c.metadata.role = 'kaizen'
    c.metadata.title = title
    c.metadata.domain = 'kaizen'
    c.data = `${metaCue}\n\n${c.data}`
  }
  return chunks
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 100
const RANGE_PAGE_SIZE = 1000
const DELETE_BATCH_SIZE = 1000

// List every ID currently in the index, paginating through `range()`.
/**
 * One range scan, used for two things: deciding what to upsert (by comparing
 * content hashes) and what to delete (by id). Reads are far cheaper than
 * writes on Upstash, and a full re-upsert of the corpus is ~4,600 writes
 * against a 10,000/day ceiling — so scanning first is what makes a no-op run
 * cost nothing instead of half the daily budget.
 *
 * Vectors written before content hashes existed have no hash and so read as
 * changed. That costs one full re-upsert, once.
 */
async function listExisting(index: Index): Promise<Map<string, string | undefined>> {
  const seen = new Map<string, string | undefined>()
  let cursor: string = ''
  do {
    const page = await index.range({ cursor, limit: RANGE_PAGE_SIZE, includeMetadata: true })
    for (const v of page.vectors) {
      const md = v.metadata as ChunkMetadata | undefined
      seen.set(v.id as string, md?.content_hash)
    }
    cursor = page.nextCursor ?? ''
  } while (cursor)
  return seen
}

async function main() {
  const args = new Set(process.argv.slice(2))

  // Refuse what we do not understand. This script writes to a shared index, and
  // an unrecognised flag used to be ignored in silence — so `--dry-run`, which
  // this copy never implemented, read as a full live run. A typo in a flag on a
  // writer is not a thing to shrug at.
  const KNOWN_FLAGS = new Set(['--reset', '--no-sync', '--dry-run'])
  const unknown = [...args].filter(a => !KNOWN_FLAGS.has(a))
  if (unknown.length) {
    console.error(`❌ Unrecognised flag(s): ${unknown.join(', ')}`)
    console.error(`   Known flags: ${[...KNOWN_FLAGS].join(', ')}`)
    process.exit(1)
  }

  const shouldReset = args.has('--reset')
  const shouldSync = !args.has('--no-sync')
  const dryRun = args.has('--dry-run')

  const vectorUrl = process.env.UPSTASH_VECTOR_REST_URL
  const vectorToken = process.env.UPSTASH_VECTOR_REST_TOKEN

  if (!vectorUrl || !vectorToken) {
    console.error('❌ Missing UPSTASH_VECTOR_REST_URL or UPSTASH_VECTOR_REST_TOKEN')
    console.error('   Add them to apps/web/.env.local and Vercel environment variables.')
    process.exit(1)
  }

  const index = new Index({ url: vectorUrl, token: vectorToken })

  if (dryRun) {
    const kaizen = findKaizenFiles()
    const chunks = kaizen.flatMap(f => buildKaizenChunks(f))
    console.log(`DRY RUN — ${chunks.length} chunks from ${kaizen.length} kaizen file(s)`)
    for (const c of chunks) console.log('  ' + c.id)
    const foreign = chunks.filter(c => !OWNED_PREFIXES.some(pre => c.id.startsWith(pre)))
    console.log(
      foreign.length
        ? `❌ ${foreign.length} ID(s) fall outside ${OWNED_PREFIXES.join(', ')}`
        : `✅ all ${chunks.length} IDs sit under ${OWNED_PREFIXES.join(', ')}`,
    )
    console.log('No writes performed.')
    return
  }

  if (shouldReset) {
    console.log('⚠️  --reset: wiping all vectors from the Upstash index...')
    await index.reset()
    console.log('   Index reset complete.\n')
  }

  // The corpus moved to opencosmos-ai/knowledge, which embeds it. These walks
  // stay only so this file keeps working while knowledge/ is still present; once
  // it is removed they yield nothing rather than throwing.
  const kaizenFiles = findKaizenFiles()
  console.log(`Found ${kaizenFiles.length} kaizen file(s)`)

  const allChunks: VectorChunk[] = []
  for (const file of kaizenFiles) {
    const chunks = buildKaizenChunks(file)
    allChunks.push(...chunks)
    if (chunks.length > 0) {
      console.log(`  ${relative(ROOT_DIR, file)} → ${chunks.length} kaizen chunks`)
    }
  }
  // Defensive check: catch ID collisions across the corpus before they hit Upstash.
  // Same-file collisions are already disambiguated by `shortHash()`; cross-file
  // collisions would indicate a bug in the ID scheme.
  const seenIds = new Set<string>()
  for (const chunk of allChunks) {
    if (seenIds.has(chunk.id)) {
      console.error(`❌ Duplicate chunk ID detected: ${chunk.id}`)
      process.exit(1)
    }
    seenIds.add(chunk.id)
  }

  for (const c of allChunks) {
    c.metadata.content_hash = createHash('sha256').update(c.data).digest('hex').slice(0, 16)
  }

  console.log(`\nBuilt ${allChunks.length} chunks total. Reading index to find what changed...`)
  const existing = await listExisting(index)
  const toUpsert = shouldReset
    ? allChunks
    : allChunks.filter(c => existing.get(c.id) !== c.metadata.content_hash)
  const unchanged = allChunks.length - toUpsert.length
  console.log(`   ${unchanged} unchanged, ${toUpsert.length} new or changed.`)

  if (toUpsert.length === 0) console.log('   Nothing to upsert.')

  let upserted = 0
  for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
    const batch = toUpsert.slice(i, i + BATCH_SIZE)
    try {
      await index.upsert(batch)
      upserted += batch.length
      process.stdout.write(`  ${upserted}/${toUpsert.length}\r`)
    } catch (err) {
      console.error(`\n❌ Batch upsert failed at index ${i}:`, err)
      // Log the first few IDs in the batch to help debug
      console.error(`   First ID in batch: ${batch[0]?.id}`)
      throw err // Still fail the CI, but with better info
    }
  }
  console.log(`\n✅ Upserted ${allChunks.length} chunks.`)

  // Stale-ID sync: delete any vectors in Upstash that no longer match a chunk
  // in the current corpus. Handles file deletions, renames, and ID-format
  // migrations without leaving orphaned vectors that pollute RAG retrieval.
  // Skipped on --reset (the index is already empty) and --no-sync (escape hatch).
  if (shouldSync && !shouldReset) {
    console.log('\nReconciling index with corpus (sync)...')
    // Only reconcile IDs this repository owns. The index is shared — the
    // corpus is also written from opencosmos-ai/knowledge — and deleting every
    // ID this run did not produce would wipe whatever the other writer owns.
    // This matters most at the Phase 4 cutover: once knowledge/ is removed from
    // this repository, an unguarded run here would produce only kaizen chunks
    // and delete all ~4,600 corpus vectors, taking Cosmo's retrieval dark.
    const existingIds = [...existing.keys()].filter(id =>
      OWNED_PREFIXES.some(prefix => id.startsWith(prefix)),
    )
    const foreign = existing.size - existingIds.length
    if (foreign > 0) console.log(`   ${foreign} vector(s) owned by another writer — left untouched.`)
    const stale = existingIds.filter(id => !seenIds.has(id))
    if (stale.length === 0) {
      console.log(`   Index is in sync (${existingIds.length} owned vectors, 0 stale).`)
    } else {
      console.log(`   Deleting ${stale.length} stale vector(s) (of ${existingIds.length} owned)...`)
      for (let i = 0; i < stale.length; i += DELETE_BATCH_SIZE) {
        const batch = stale.slice(i, i + DELETE_BATCH_SIZE)
        await index.delete(batch)
      }
      console.log(`   Sync complete.`)
    }
  }

  console.log(`\n✅ Done — ${allChunks.length} chunks live in Upstash Vector (${toUpsert.length} written this run)`)
}

main().catch(err => {
  console.error('❌ Embed failed:', err)
  process.exit(1)
})
