import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { promises as fs, existsSync } from 'fs'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 1800

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const DOWNLOAD_DIR = '/home/z/my-project/download'
const TRACK_DIR = path.join(DOWNLOAD_DIR, 'track')
const TRACK_BATCH = 100
const BATCH_SIZE = 10
const BATCH_PAUSE_MS = 20_000
const BATCH_CONCURRENCY = 3

// libgen.li is the ONLY download source. All network calls go through curl
// (shell) — no fetch(), no SDK, no AI, no search. The download flow is:
//   1. GET index.php?req=DOI&columns[]=t&objects[]=f&objects[]=e&topics[]=a
//      → results page, parse first edition.php?id=NNN
//   2. GET edition.php?id=NNN → parse md5=HASH (+ downloadname)
//   3. GET ads.php?md5=HASH&downloadname=DOI → parse get.php?md5=HASH&key=KEY
//   4. GET get.php?md5=HASH&key=KEY (with Referer) → the PDF bytes
const LIBGEN_BASE = 'https://libgen.li'
const execFileAsync = promisify(execFile)

type Paper = {
  doi: string; title: string; journal?: string; year?: string
  authors?: string; abstract?: string
  folders?: string[]
}

type DLFile = { filename: string; doi: string; size: number }
type TrackEntry = { doi: string; title: string; filename: string; added_at: number }

const safeFilename = (doi: string) => doi.replaceAll(/[^A-Za-z0-9._-]/g, '_')

const parseDoiInput = (s: string): string => {
  const m = (s || '').match(/\b10\.\d{4,9}\/[^\s"<>]+/)
  if (!m) return ''
  return m[0].replace(/[.,;)]+$/, '')
}

// ---------- Folder name cleaning ----------
function cleanFolderName(name: string): string {
  if (!name) return ''
  let cleaned = name.replace(/[\u2010-\u2015\u002D]/g, '').trim()
  cleaned = cleaned.replace(/\s+/g, ' ')
  if (!cleaned) return ''
  return cleaned[0].toUpperCase() + cleaned.slice(1)
}

function cleanFolderList(folders: unknown): string[] {
  if (!Array.isArray(folders)) return []
  return folders
    .map(f => cleanFolderName(String(f || '')))
    .filter(Boolean)
}

// ====================================================================
// libgen.li download — ALL via curl (shell). No fetch, no SDK, no AI.
// ====================================================================

async function curlGet(url: string, referer?: string): Promise<string> {
  const args = [
    '-sSL', '--compressed',
    '-A', UA,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: en-US,en;q=0.5',
    '--max-time', '45',
  ]
  if (referer) { args.push('-e', referer) }
  args.push(url)
  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}

async function curlDownload(url: string, outputPath: string, referer?: string): Promise<{ size: number; error?: string }> {
  const args = [
    '-sSL', '--compressed',
    '-A', UA,
    '-H', 'Accept: */*',
    '--max-time', '120',
    '-o', outputPath,
    '-w', '%{http_code} %{size_download}',
  ]
  if (referer) { args.push('-e', referer) }
  args.push(url)
  try {
    const { stdout, stderr } = await execFileAsync('curl', args, { maxBuffer: 4096 })
    const parts = stdout.trim().split(/\s+/)
    const code = parts[0] || ''
    const size = parseInt(parts[1] || '0', 10) || 0
    if (size === 0) {
      const detail = stderr.trim().slice(0, 200) || `http ${code}, empty body`
      return { size: 0, error: `curl http=${code} ${detail}` }
    }
    return { size, error: undefined }
  } catch (e: any) {
    const detail = (e?.stderr || e?.message || String(e)).toString().slice(0, 200)
    return { size: 0, error: `curl failed: ${detail}` }
  }
}

// Step 1 — search libgen.li (Scientific Articles topic) by DOI.
async function libgenSearchEdition(doi: string): Promise<string> {
  const url = `${LIBGEN_BASE}/index.php?req=${encodeURIComponent(doi)}&columns%5B%5D=t&objects%5B%5D=f&objects%5B%5D=e&topics%5B%5D=a`
  const html = await curlGet(url)
  if (!html) return ''
  const m = html.match(/edition\.php\?id=(\d+)/)
  return m ? m[1] : ''
}

// Step 2 — fetch the edition page, extract the md5 (and downloadname).
async function libgenGetMd5(editionId: string): Promise<{ md5: string; downloadname: string } | null> {
  const url = `${LIBGEN_BASE}/edition.php?id=${editionId}`
  const html = await curlGet(url)
  if (!html) return null
  const m = html.match(/md5=([a-f0-9]{32})/)
  if (!m) return null
  const dn = html.match(/downloadname=([^"'\s&]+)/)
  return { md5: m[1], downloadname: dn ? dn[1] : '' }
}

// Step 3 — fetch the ads page, extract the get.php?md5=…&key=… link.
async function libgenGetDownloadUrl(md5: string, downloadname: string): Promise<string | null> {
  const adsUrl = `${LIBGEN_BASE}/ads.php?md5=${md5}` + (downloadname ? `&downloadname=${downloadname}` : '')
  const html = await curlGet(adsUrl)
  if (!html) return null
  const m = html.match(/get\.php\?md5=[a-f0-9]{32}&key=[A-Za-z0-9]+/)
  if (!m) return null
  return `${LIBGEN_BASE}/${m[0]}`
}

type LibgenResult = { filename: string; success: boolean; error?: string; size?: number }

// Full download flow for one DOI via libgen.li (curl only).
async function libgenDownloadPaper(doi: string): Promise<LibgenResult> {
  const filename = `${safeFilename(doi)}.pdf`
  const target = path.join(DOWNLOAD_DIR, filename)
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true })

  if (existsSync(target)) {
    const st = await fs.stat(target)
    return { filename, success: true, size: st.size }
  }

  const editionId = await libgenSearchEdition(doi)
  if (!editionId) {
    return { filename, success: false, error: 'not on libgen.li (no edition)' }
  }

  const md5Info = await libgenGetMd5(editionId)
  if (!md5Info) {
    return { filename, success: false, error: 'no md5 on edition page' }
  }

  const dlUrl = await libgenGetDownloadUrl(md5Info.md5, md5Info.downloadname)
  if (!dlUrl) {
    return { filename, success: false, error: 'no download link on ads page' }
  }

  const partial = `${target}.partial`
  try { await fs.unlink(partial) } catch {}
  const adsReferer = `${LIBGEN_BASE}/ads.php?md5=${md5Info.md5}`
  const { size, error: dlError } = await curlDownload(dlUrl, partial, adsReferer)
  if (size === 0) {
    try { await fs.unlink(partial) } catch {}
    return { filename, success: false, error: dlError || 'download empty' }
  }
  // verify magic bytes: must start with %PDF
  const fd = await fs.open(partial, 'r')
  const buf = Buffer.alloc(5)
  await fd.read(buf, 0, 5, 0)
  await fd.close()
  if (buf.toString('ascii') !== '%PDF-') {
    const snippet = (await fs.readFile(partial, 'utf8').catch(() => '')).slice(0, 200)
    try { await fs.unlink(partial) } catch {}
    return { filename, success: false, error: `not a PDF (got ${size}b): ${snippet.replace(/\s+/g, ' ').slice(0, 120)}` }
  }
  await fs.rename(partial, target)
  return { filename, success: true, size }
}

// ---------- Track store ----------
async function currentTrackFile(): Promise<string> {
  await fs.mkdir(TRACK_DIR, { recursive: true })
  let i = 1
  while (true) {
    const f = path.join(TRACK_DIR, `papers${String(i).padStart(3, '0')}.json`)
    if (!existsSync(f)) return f
    try {
      const data = JSON.parse(await fs.readFile(f, 'utf8'))
      if ((data.papers || []).length < TRACK_BATCH) return f
    } catch { return f }
    i++
  }
}

async function markDownloaded(doi: string, title: string, filename: string): Promise<void> {
  const f = await currentTrackFile()
  let data: any = { papers: [] }
  if (existsSync(f)) {
    try { data = JSON.parse(await fs.readFile(f, 'utf8')) } catch { data = { papers: [] } }
  }
  if (!data.papers) data.papers = []
  if (data.papers.some((p: TrackEntry) => p.doi === doi)) return
  data.papers.push({ doi, title, filename, added_at: Date.now() })
  await fs.writeFile(f, JSON.stringify(data, null, 2))
}

async function getAllTrackEntries(): Promise<TrackEntry[]> {
  const names = await fs.readdir(TRACK_DIR).catch(() => [] as string[])
  const out: TrackEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const data = JSON.parse(await fs.readFile(path.join(TRACK_DIR, name), 'utf8'))
      for (const p of data.papers || []) out.push(p)
    } catch {}
  }
  return out
}

// ---------- Zip ----------
async function createZipOfFiles(files: string[], outputName: string): Promise<string> {
  const outPath = path.join(DOWNLOAD_DIR, outputName)
  try { await fs.unlink(outPath) } catch {}
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true })
  if (files.length === 0) {
    await fs.writeFile(outPath, Buffer.from('PK\x05\x06' + '\x00'.repeat(18)))
    return outPath
  }
  const args = files.length > 50 ? ['-j', '-q', outPath, '-@'] : ['-j', '-q', outPath, ...files]
  const proc = spawn('zip', args, { cwd: DOWNLOAD_DIR })
  if (files.length > 50) {
    proc.stdin.write(files.join('\n'))
    proc.stdin.end()
  }
  await new Promise<void>((res, rej) => {
    const chunks: Buffer[] = []
    proc.stderr.on('data', d => chunks.push(d))
    proc.on('close', code => code === 0 ? res() : rej(new Error('zip failed: ' + Buffer.concat(chunks).toString())))
    proc.on('error', rej)
  })
  return outPath
}

async function createZipWithFolders(
  files: { doi: string; filename: string; folders: string[] }[],
  outputName: string
): Promise<string> {
  const stagingDir = path.join(DOWNLOAD_DIR, `.staging-${randomUUID()}`)
  await fs.mkdir(stagingDir, { recursive: true })
  try {
    for (const f of files) {
      const srcPath = path.join(DOWNLOAD_DIR, f.filename)
      if (!existsSync(srcPath)) continue
      const folderPath = f.folders.length > 0 ? path.join(stagingDir, ...f.folders) : stagingDir
      await fs.mkdir(folderPath, { recursive: true })
      const dstPath = path.join(folderPath, f.filename)
      await fs.copyFile(srcPath, dstPath)
    }
    const outPath = path.join(DOWNLOAD_DIR, outputName)
    try { await fs.unlink(outPath) } catch {}
    const proc = spawn('zip', ['-r', '-q', outPath, '.'], { cwd: stagingDir })
    await new Promise<void>((res, rej) => {
      const chunks: Buffer[] = []
      proc.stderr.on('data', d => chunks.push(d))
      proc.on('close', code => code === 0 ? res() : rej(new Error('zip failed: ' + Buffer.concat(chunks).toString())))
      proc.on('error', rej)
    })
    return outPath
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------- Concurrency pool ----------
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// ---------- Routes ----------
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const action = url.searchParams.get('action')
  try {
    if (action === 'list') {
      await fs.mkdir(DOWNLOAD_DIR, { recursive: true })
      const names = await fs.readdir(DOWNLOAD_DIR)
      const out: DLFile[] = []
      for (const name of names) {
        if (!name.endsWith('.pdf')) continue
        const full = path.join(DOWNLOAD_DIR, name)
        const st = await fs.stat(full)
        const doi = name.replace(/\.pdf$/, '').replaceAll('_', '/')
        out.push({ filename: name, doi, size: st.size })
      }
      return NextResponse.json({ files: out })
    }
    if (action === 'track') {
      const entries = await getAllTrackEntries()
      return NextResponse.json({ entries, count: entries.length })
    }
    if (action === 'track-backup') {
      const tnames = (await fs.readdir(TRACK_DIR).catch(() => [] as string[])).filter(f => f.endsWith('.json'))
      const files = tnames.map(f => path.join(TRACK_DIR, f))
      const zipName = `track-backup-${Date.now()}.zip`
      await createZipOfFiles(files, zipName)
      return NextResponse.json({ zipUrl: `/api/papers?action=open&file=${encodeURIComponent(zipName)}` })
    }
    if (action === 'open') {
      const file = url.searchParams.get('file') || ''
      const target = path.join(DOWNLOAD_DIR, path.basename(file))
      if (!existsSync(target)) return NextResponse.json({ error: 'not found' }, { status: 404 })
      const buf = await fs.readFile(target)
      const isZip = file.endsWith('.zip')
      return new NextResponse(buf, {
        headers: {
          'Content-Type': isZip ? 'application/zip' : 'application/pdf',
          'Content-Disposition': `${isZip ? 'attachment' : 'inline'}; filename="${path.basename(file)}"`,
          'Content-Length': String(buf.length),
        },
      })
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // single download via libgen.li (curl) — STREAMING so the UI can show
    // sub-status (searching → fetching → downloading) instead of a flat "…"
    if (body.action === 'download') {
      const doi = parseDoiInput(body.doi)
      if (!doi) return NextResponse.json({ success: false, reason: 'NO_DOI', error: 'no doi' }, { status: 400 })
      const title = typeof body.title === 'string' && body.title ? body.title : doi
      const filename = `${safeFilename(doi)}.pdf`
      const target = path.join(DOWNLOAD_DIR, filename)

      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: any) => {
            try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')) } catch {}
          }
          try {
            await fs.mkdir(DOWNLOAD_DIR, { recursive: true })

            // cached?
            if (existsSync(target)) {
              const st = await fs.stat(target)
              await markDownloaded(doi, title, filename)
              send({ type: 'done', doi, filename, size: st.size, cached: true })
              controller.close()
              return
            }

            // Step 1: search
            send({ type: 'step', doi, step: 'search', label: 'searching libgen.li' })
            const editionId = await libgenSearchEdition(doi)
            if (!editionId) {
              send({ type: 'error', doi, reason: 'LIBGEN_FAILED', error: 'not on libgen.li (no edition)' })
              controller.close(); return
            }

            // Step 2: edition → md5
            send({ type: 'step', doi, step: 'edition', label: 'found · fetching metadata' })
            const md5Info = await libgenGetMd5(editionId)
            if (!md5Info) {
              send({ type: 'error', doi, reason: 'LIBGEN_FAILED', error: 'no md5 on edition page' })
              controller.close(); return
            }

            // Step 3: ads → download URL
            send({ type: 'step', doi, step: 'ads', label: 'resolving download link' })
            const dlUrl = await libgenGetDownloadUrl(md5Info.md5, md5Info.downloadname)
            if (!dlUrl) {
              send({ type: 'error', doi, reason: 'LIBGEN_FAILED', error: 'no download link on ads page' })
              controller.close(); return
            }

            // Step 4: download the PDF
            send({ type: 'step', doi, step: 'download', label: 'downloading pdf' })
            const partial = `${target}.partial`
            try { await fs.unlink(partial) } catch {}
            const adsReferer = `${LIBGEN_BASE}/ads.php?md5=${md5Info.md5}`
            const { size, error: dlError } = await curlDownload(dlUrl, partial, adsReferer)
            if (size === 0) {
              try { await fs.unlink(partial) } catch {}
              send({ type: 'error', doi, reason: 'LIBGEN_FAILED', error: dlError || 'download empty' })
              controller.close(); return
            }
            // verify %PDF magic
            const fd = await fs.open(partial, 'r')
            const buf = Buffer.alloc(5)
            await fd.read(buf, 0, 5, 0)
            await fd.close()
            if (buf.toString('ascii') !== '%PDF-') {
              const snippet = (await fs.readFile(partial, 'utf8').catch(() => '')).slice(0, 200)
              try { await fs.unlink(partial) } catch {}
              send({ type: 'error', doi, reason: 'LIBGEN_FAILED', error: `not a PDF: ${snippet.replace(/\s+/g, ' ').slice(0, 120)}` })
              controller.close(); return
            }
            await fs.rename(partial, target)
            await markDownloaded(doi, title, filename)
            send({ type: 'done', doi, filename, size })
          } catch (e: any) {
            send({ type: 'error', doi, reason: 'EXCEPTION', error: e?.message || String(e) })
          }
          controller.close()
        },
      })

      return new NextResponse(stream, {
        headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
      })
    }

    // ---- Folder-aware bulk download (libgen.li via curl) ----
    if (body.action === 'bulk') {
      const rawItems: any[] = Array.isArray(body.items) ? body.items : []
      const items: { doi: string; title: string; folders: string[] }[] = rawItems
        .filter((x: any) => x && parseDoiInput(x.doi))
        .map((x: any) => ({
          doi: parseDoiInput(x.doi),
          title: typeof x.title === 'string' && x.title ? x.title : parseDoiInput(x.doi),
          folders: cleanFolderList(x.folders),
        }))

      const mode: 'loose' | 'zip' = body.mode === 'zip' ? 'zip' : 'loose'

      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: any) => {
            try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')) } catch {}
          }

          const okResults: { doi: string; filename: string; folders: string[] }[] = []
          let completedPapers = 0
          const totalPapers = items.length

          const folderGroups = new Map<string, { doi: string; title: string; folders: string[] }[]>()
          for (const item of items) {
            const key = item.folders.join('/')
            const arr = folderGroups.get(key)
            if (arr) arr.push(item)
            else folderGroups.set(key, [item])
          }
          const folderList = Array.from(folderGroups.entries()).map(([folder, papers]) => ({ folder, papers }))
          const totalFolders = folderList.length
          let completedFolders = 0

          const emitProgress = (currentFolder: string) => {
            send({ type: 'progress', completedFolders, totalFolders, completedPapers, totalPapers, currentFolder })
          }
          emitProgress(folderList[0]?.folder || '')

          let papersSincePause = 0

          const processOne = async (item: { doi: string; title: string; folders: string[] }) => {
            try {
              const r = await libgenDownloadPaper(item.doi)
              if (r.success) {
                await markDownloaded(item.doi, item.title, r.filename)
                okResults.push({ doi: item.doi, filename: r.filename, folders: item.folders })
                send({ doi: item.doi, success: true, filename: r.filename, size: r.size, folders: item.folders })
              } else {
                send({ doi: item.doi, success: false, reason: 'LIBGEN_FAILED', error: r.error, folders: item.folders })
              }
            } catch (e: any) {
              send({ doi: item.doi, success: false, reason: 'EXCEPTION', error: e?.message || String(e), folders: item.folders })
            }
          }

          for (let fi = 0; fi < folderList.length; fi++) {
            const fg = folderList[fi]
            send({ type: 'folder-start', folder: fg.folder, count: fg.papers.length, completedFolders, totalFolders, completedPapers, totalPapers })

            let i = 0
            while (i < fg.papers.length) {
              const slotsUntilPause = BATCH_SIZE - papersSincePause
              const batchEnd = Math.min(i + slotsUntilPause, fg.papers.length)
              const batch = fg.papers.slice(i, batchEnd)

              await pool(batch, BATCH_CONCURRENCY, async (item) => {
                await processOne(item)
                completedPapers++
                papersSincePause++
                emitProgress(fg.folder)
              })

              i = batchEnd

              const moreRemaining = i < fg.papers.length || fi < folderList.length - 1
              if (papersSincePause >= BATCH_SIZE && moreRemaining) {
                const remainingAfter = totalPapers - completedPapers
                send({ type: 'throttle', waitMs: BATCH_PAUSE_MS, completedPapers, totalPapers, remaining: remainingAfter })
                await new Promise<void>(r => setTimeout(r, BATCH_PAUSE_MS))
                papersSincePause = 0
              }
            }

            completedFolders++
            send({ type: 'folder-done', folder: fg.folder, completedFolders, totalFolders, completedPapers, totalPapers })
          }

          if (mode === 'zip' && okResults.length > 0) {
            const zipName = `${(body.zipName || 'papers').replace(/\.zip$/i, '')}.zip`
            try {
              await createZipWithFolders(okResults, zipName)
              send({ type: 'zip-ready', zipUrl: `/api/papers?action=open&file=${encodeURIComponent(zipName)}`, count: okResults.length })
            } catch (e: any) {
              send({ type: 'zip-error', error: e?.message || String(e) })
            }
          }

          send({ type: 'done', total: items.length, succeeded: okResults.length })
          controller.close()
        },
      })

      return new NextResponse(stream, {
        headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
      })
    }

    return NextResponse.json({ success: false, error: 'unknown action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
