'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'

// Light, clean, tiny
const C = {
  bg: '#ffffff', surface: '#ffffff', border: '#ececec', borderStrong: '#d4d4d4',
  text: '#111111', muted: '#6a6a6a', dim: '#9a9a9a',
  selBg: '#f2f2f2', selBorder: '#111111',
  idle: '#111111', orange: '#c2410c', green: '#16a34a', red: '#dc2626',
  overlay: 'rgba(0,0,0,0.35)',
  bar: '#e8e8e8', barFill: '#c2410c',
}
const R = { row: 3, btn: 3, pill: 3 }
const mono = 'ui-monospace, "SF Mono", Menlo, "Cascadia Code", monospace'

type Paper = {
  doi: string; title: string; journal?: string; year?: string
  authors?: string; abstract?: string
  folders?: string[]
}
type DLState = 'idle' | 'resolving' | 'done' | 'failed'
type Mode = 'main' | 'classics'

type BulkProgress = {
  completedFolders: number
  totalFolders: number
  completedPapers: number
  totalPapers: number
  currentFolder: string
  waitSeconds?: number | null
} | null

const safeFilename = (doi: string) => doi.replaceAll(/[^A-Za-z0-9._-]/g, '_')

// filename-style row — FULL title (wraps), state button, nothing else
function PaperRow({ paper, state, error, selected, onDownload, onPress, onClick, showFolder }: {
  paper: Paper; state: DLState; error?: string; selected: boolean
  onDownload: () => void; onPress: (p: Paper) => void; onClick: (p: Paper) => void
  showFolder?: boolean
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressed = useRef(false)
  const sx = useRef(0), sy = useRef(0)
  const down = (e: React.PointerEvent) => {
    suppressed.current = false
    sx.current = e.clientX; sy.current = e.clientY
    timer.current = setTimeout(() => { suppressed.current = true; onPress(paper) }, 450)
  }
  const move = (e: React.PointerEvent) => {
    if (!timer.current) return
    if (Math.abs(e.clientX - sx.current) > 10 || Math.abs(e.clientY - sy.current) > 10) {
      clearTimeout(timer.current); timer.current = null
    }
  }
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  const click = () => { if (suppressed.current) { suppressed.current = false; return } onClick(paper) }
  const btnColor = state === 'done' ? C.green : state === 'failed' ? C.red : state === 'resolving' ? C.orange : C.idle
  const btnLabel = state === 'done' ? 'open' : state === 'failed' ? '—' : state === 'resolving' ? '…' : 'get'
  const folderPath = showFolder && paper.folders && paper.folders.length > 0 ? paper.folders.join('/') : ''
  // When the file is downloaded, render the action as a real <a> link so the
  // browser opens/downloads it via native navigation (can't be blocked by
  // popup blockers or sandbox restrictions the way a JS click() can).
  const openHref = state === 'done' ? `/api/papers?action=open&file=${encodeURIComponent(`${safeFilename(paper.doi)}.pdf`)}` : ''
  const actionStyle: React.CSSProperties = {
    background: btnColor, color: '#fff', border: 'none', padding: '2px 6px', fontSize: 10,
    cursor: state === 'resolving' ? 'default' : 'pointer', borderRadius: R.btn, fontFamily: mono,
    flexShrink: 0, marginTop: 1, opacity: state === 'resolving' ? 0.5 : 1, minWidth: 26,
    textDecoration: 'none', display: 'inline-block', lineHeight: 1.4,
  }
  const actionEl = state === 'done' ? (
    <a href={openHref} target="_blank" rel="noopener" style={actionStyle} onClick={(e) => e.stopPropagation()}>{btnLabel}</a>
  ) : (
    <button onClick={(e) => { e.stopPropagation(); onDownload() }} disabled={state === 'resolving'} style={actionStyle}>{btnLabel}</button>
  )
  return (
    <div onPointerDown={down} onPointerMove={move} onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel} onClick={click}
      style={{ borderBottom: `1px solid ${C.border}`, background: selected ? C.selBg : C.bg, cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'pan-y' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '7px 9px' }}>
        {selected && <span style={{ width: 6, height: 6, background: C.selBorder, borderRadius: 1, display: 'inline-block', flexShrink: 0, marginTop: 5 }} />}
        <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: C.text, lineHeight: 1.35, wordBreak: 'break-word', whiteSpace: 'normal' }}>{paper.title}</div>
        {actionEl}
      </div>
      {folderPath && (
        <div style={{ padding: '0 9px 4px', fontSize: 9, color: C.dim, fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {folderPath}</div>
      )}
      {state === 'failed' && error && (
        <div style={{ padding: '0 9px 5px', fontSize: 10, color: C.red, lineHeight: 1.3, wordBreak: 'break-word' }}>{error}</div>
      )}
    </div>
  )
}

// ---------- Folder name cleaning (mirrors backend) ----------
function cleanFolderName(name: string): string {
  if (!name) return ''
  let cleaned = name.replace(/[\u2010-\u2015\u002D]/g, '').trim()
  cleaned = cleaned.replace(/\s+/g, ' ')
  if (!cleaned) return ''
  return cleaned[0].toUpperCase() + cleaned.slice(1)
}

// ---------- Bulk parser with folder support ----------
function parseBulkWithFolders(text: string): { doi: string; folders: string[] }[] {
  const out: { doi: string; folders: string[] }[] = []
  const currentFolders: string[] = []
  let prevWasFolder = false
  const lines = (text || '').split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      currentFolders.length = 0
      prevWasFolder = false
      continue
    }

    const hasDoi = /\b10\.\d{4,9}\//.test(line)

    // Standalone folder definition: /folder/ or /a/b/c/  (NO doi on the line)
    const folderOnly = line.match(/^\/(.+)\/$/)
    if (folderOnly && !hasDoi) {
      const segs = folderOnly[1].split('/').map(s => cleanFolderName(s)).filter(Boolean)
      if (prevWasFolder && segs.length > 0) {
        currentFolders.push(...segs)
      } else {
        currentFolders.length = 0
        currentFolders.push(...segs)
      }
      prevWasFolder = true
      continue
    }

    // Inline form: /folder/folder/10.1234/abc  (explicit full path, doesn't change context)
    const inline = line.match(/^\/(.+?)\/(10\.\d{4,9}\/[^\s"<>|]+)/)
    if (inline) {
      const segs = inline[1].split('/').map(s => cleanFolderName(s)).filter(Boolean)
      const doi = inline[2].replace(/[.,;)]+$/, '')
      if (doi) out.push({ doi, folders: segs })
      const rest = line.slice(inline[0].length)
      if (rest.includes('|')) {
        for (const part of rest.split('|')) {
          const m = part.match(/\b10\.\d{4,9}\/[^\s"<>]+/)
          if (m) out.push({ doi: m[0].replace(/[.,;)]+$/, ''), folders: [...segs] })
        }
      }
      prevWasFolder = false
      continue
    }

    // Plain DOI line (may contain | separators) — use current folder context
    prevWasFolder = false
    for (const part of line.split('|')) {
      const m = part.match(/\b10\.\d{4,9}\/[^\s"<>]+/)
      if (m) out.push({ doi: m[0].replace(/[.,;)]+$/, ''), folders: [...currentFolders] })
    }
  }
  return out
}

// Group papers by folder path, preserving first-appearance order.
function groupByFolder(papers: Paper[]): { folder: string; folders: string[]; papers: Paper[] }[] {
  const map = new Map<string, { folders: string[]; papers: Paper[] }>()
  for (const p of papers) {
    const folders = p.folders || []
    const key = folders.join('/')
    const existing = map.get(key)
    if (existing) existing.papers.push(p)
    else map.set(key, { folders, papers: [p] })
  }
  return Array.from(map.entries()).map(([folder, v]) => ({ folder, folders: v.folders, papers: v.papers }))
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('main')

  const [showTrack, setShowTrack] = useState(false)
  const [trackEntries, setTrackEntries] = useState<{ doi: string; title: string; filename: string; added_at: number }[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200) }

  // main — no metadata lookup; the DOI is the title.
  const [input, setInput] = useState('')
  const [searched, setSearched] = useState<Paper | null>(null)

  // classics — papers are derived LIVE from the textarea
  const [bulkText, setBulkText] = useState('')
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>(null)
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const throttleTickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopThrottleTick = useCallback(() => {
    if (throttleTickRef.current) { clearInterval(throttleTickRef.current); throttleTickRef.current = null }
  }, [])
  useEffect(() => () => stopThrottleTick(), [stopThrottleTick])

  // shared download state
  const [dlStates, setDlStates] = useState<Record<string, DLState>>({})
  const [dlErrors, setDlErrors] = useState<Record<string, string>>({})

  // selection
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectedRef = useRef(selected); selectedRef.current = selected
  const selectingRef = useRef(selecting); selectingRef.current = selecting

  // zip dialog
  const [zipDialog, setZipDialog] = useState<{ items: Paper[]; mode: 'loose' | 'zip' } | null>(null)
  const [zipName, setZipName] = useState('')

  // derived: parse the textarea live into papers (DOI as title, folders attached).
  const bulkPapers = useMemo<Paper[]>(
    () => parseBulkWithFolders(bulkText).map(({ doi, folders }) => ({ doi, title: doi, folders })),
    [bulkText]
  )

  const openFile = (filename: string) => {
    const url = `/api/papers?action=open&file=${encodeURIComponent(filename)}`
    // Append a real <a download> link and click it. This is more reliable
    // across sandbox/headless browsers than a detached anchor, and the
    // `download` attribute hints the browser to save rather than navigate.
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    a.rel = 'noopener'
    a.style.position = 'fixed'
    a.style.left = '-9999px'
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { try { document.body.removeChild(a) } catch {} }, 1000)
  }

  const setDl = (doi: string, s: DLState, err?: string) => {
    setDlStates(p => ({ ...p, [doi]: s }))
    if (err !== undefined) setDlErrors(p => ({ ...p, [doi]: err }))
  }

  const singleDownload = async (paper: Paper) => {
    setDl(paper.doi, 'resolving')
    try {
      const res = await fetch('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', doi: paper.doi, title: paper.title }) })
      const data = await res.json()
      if (data.success) { setDl(paper.doi, 'done'); showToast(`got ${data.filename}`) }
      else setDl(paper.doi, 'failed', `${data.reason || 'failed'}: ${data.error || ''}`.slice(0, 160))
    } catch (e: any) { setDl(paper.doi, 'failed', e?.message || String(e)) }
  }

  // streaming bulk download — folder-by-folder, progress streamed as NDJSON.
  // Downloads come from libgen.li (curl shell). 10-paper/20s throttle with countdown.
  const bulkDownload = async (items: Paper[], mode: 'loose' | 'zip', zipName?: string) => {
    if (items.length === 0) { showToast('nothing selected'); return }
    items.forEach(p => setDl(p.doi, 'resolving'))
    setSelecting(false); setSelected(new Set())
    setBulkDownloading(true)
    setBulkProgress({ completedFolders: 0, totalFolders: 0, completedPapers: 0, totalPapers: items.length, currentFolder: '', waitSeconds: null })
    const clearWait = () => { stopThrottleTick(); setBulkProgress(p => p ? { ...p, waitSeconds: null } : p) }
    const startWaitCountdown = (secs: number) => {
      stopThrottleTick()
      setBulkProgress(p => p ? { ...p, waitSeconds: secs } : p)
      throttleTickRef.current = setInterval(() => {
        setBulkProgress(p => {
          if (!p || p.waitSeconds == null) return p
          const next = p.waitSeconds - 1
          if (next <= 0) {
            if (throttleTickRef.current) { clearInterval(throttleTickRef.current); throttleTickRef.current = null }
            return { ...p, waitSeconds: null }
          }
          return { ...p, waitSeconds: next }
        })
      }, 1000)
    }
    try {
      const res = await fetch('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'bulk', items: items.map(p => ({ doi: p.doi, title: p.title, folders: p.folders || [] })), mode, zipName }) })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line)
            if (ev.type === 'throttle') {
              startWaitCountdown(Math.max(1, Math.round((ev.waitMs ?? 20000) / 1000)))
              setBulkProgress(p => p ? {
                ...p,
                completedFolders: ev.completedFolders ?? p.completedFolders,
                totalFolders: ev.totalFolders ?? p.totalFolders,
                completedPapers: ev.completedPapers ?? p.completedPapers,
                totalPapers: ev.totalPapers ?? p.totalPapers,
                currentFolder: p.currentFolder,
              } : p)
            } else if (ev.type === 'progress' || ev.type === 'folder-start' || ev.type === 'folder-done') {
              clearWait()
              setBulkProgress({
                completedFolders: ev.completedFolders ?? 0,
                totalFolders: ev.totalFolders ?? 0,
                completedPapers: ev.completedPapers ?? 0,
                totalPapers: ev.totalPapers ?? items.length,
                currentFolder: ev.type === 'folder-start' ? (ev.folder ?? '') : ev.type === 'folder-done' ? '' : (ev.currentFolder ?? ''),
                waitSeconds: null,
              })
            } else if (ev.type === 'zip-ready') {
              openFile(ev.zipUrl.split('file=')[1])
            } else if (ev.type === 'done') {
              showToast(`done: ${ev.succeeded}/${ev.total}`)
            } else if (ev.doi) {
              clearWait()
              if (ev.success) {
                setDl(ev.doi, 'done')
                if (mode === 'loose' && ev.filename) openFile(ev.filename)
              }
              else setDl(ev.doi, 'failed', `${ev.reason || 'failed'}: ${ev.error || ''}`.slice(0, 160))
            }
          } catch {}
        }
      }
    } catch (e: any) { showToast(e?.message || String(e)) }
    finally {
      stopThrottleTick()
      setBulkDownloading(false)
      setBulkProgress(null)
    }
  }

  // main: parse the DOI locally and show the row (download comes from libgen.li).
  const search = () => {
    const doi = parseDoi(input)
    if (!doi) { showToast('no doi'); return }
    setSearched({ doi, title: doi })
  }

  // track
  const loadTrack = async () => {
    try { const r = await fetch('/api/papers?action=track'); const d = await r.json(); setTrackEntries(d.entries || []) }
    catch (e) { showToast(e as string) }
  }

  // selection
  const toggleSel = (doi: string) => setSelected(prev => { const n = new Set(prev); if (n.has(doi)) n.delete(doi); else n.add(doi); return n })
  const onPress = (p: Paper) => { if (!selectingRef.current) setSelecting(true); toggleSel(p.doi) }
  const onCardClick = (p: Paper) => { if (selectingRef.current) toggleSel(p.doi) }

  const selectedPapers = (list: Paper[]) => list.filter(p => selected.has(p.doi))
  const allPapers = () => mode === 'classics' ? bulkPapers : (searched ? [searched] : [])

  const requestZip = (items: Paper[]) => { setZipName(''); setZipDialog({ items, mode: 'zip' }) }
  const confirmZip = () => { if (!zipName.trim()) { showToast('need a name'); return } bulkDownload(zipDialog!.items, 'zip', zipName.trim()); setZipDialog(null) }

  const btnStyle = (active = false): React.CSSProperties => ({
    background: active ? C.text : 'transparent', color: active ? '#fff' : C.muted,
    border: `1px solid ${active ? C.text : C.borderStrong}`, padding: '3px 7px', fontSize: 10,
    cursor: 'pointer', borderRadius: R.btn, fontFamily: mono, lineHeight: 1.4,
  })

  const renderRow = (p: Paper, opts: { showFolder?: boolean } = {}) => (
    <PaperRow key={p.doi} paper={p} state={dlStates[p.doi] || 'idle'} error={dlErrors[p.doi]}
      selected={selected.has(p.doi)}
      onDownload={() => singleDownload(p)} onPress={onPress} onClick={onCardClick} showFolder={opts.showFolder} />
  )

  const inner: React.CSSProperties = { maxWidth: 720, margin: '0 auto', width: '100%' }
  const stickyHead: React.CSSProperties = { position: 'sticky', top: 0, background: C.bg, zIndex: 5, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }

  const classicsGroups = useMemo(() => groupByFolder(bulkPapers), [bulkPapers])

  return (
    <div style={{ height: '100vh', background: C.bg, color: C.text, fontFamily: mono, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* top bar */}
      <header style={{ display: 'flex', gap: 5, padding: '6px 8px', borderBottom: `1px solid ${C.borderStrong}`, background: C.bg, zIndex: 10, flexShrink: 0, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={btnStyle(mode === 'main')} onClick={() => setMode('main')}>main</button>
        <button style={btnStyle(mode === 'classics')} onClick={() => setMode('classics')}>/classics</button>
        <div style={{ flex: 1 }} />
        <button style={btnStyle()} onClick={() => { setShowTrack(true); loadTrack() }}>track</button>
      </header>

      {/* single scroll container for all modes */}
      <main style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
        {mode === 'main' && (
          <div style={inner}>
            <div style={{ ...stickyHead, padding: '6px 8px', display: 'flex', gap: 5 }}>
              <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search() }}
                placeholder="doi or url"
                style={{ flex: 1, background: C.surface, color: C.text, border: `1px solid ${C.borderStrong}`, padding: '5px 7px', fontSize: 11, borderRadius: R.btn, outline: 'none', fontFamily: mono }} />
              <button style={{ ...btnStyle(), minWidth: 36 }} onClick={search}>go</button>
            </div>
            {searched && renderRow(searched)}
            {!searched && <div style={{ padding: 14, color: C.dim, fontSize: 11, textAlign: 'center' }}>—</div>}
          </div>
        )}

        {mode === 'classics' && (
          <div style={inner}>
            <div style={{ ...stickyHead, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder={'doi|\ndoi|\n\n/category/\ndoi|\ndoi|\n\n/category/\n/Category/\ndoi|'}
                style={{ width: '100%', minHeight: 60, background: C.surface, color: C.text, border: `1px solid ${C.borderStrong}`, padding: '5px 7px', fontSize: 11, borderRadius: R.btn, outline: 'none', fontFamily: mono, resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                {bulkPapers.length > 0 && <>
                  <button style={btnStyle(bulkDownloading)} onClick={() => requestZip(bulkPapers)} disabled={bulkDownloading}>{bulkDownloading ? '…' : 'all·zip'}</button>
                  <button style={btnStyle(bulkDownloading)} onClick={() => bulkDownload(bulkPapers, 'loose')} disabled={bulkDownloading}>{bulkDownloading ? '…' : 'all·loose'}</button>
                </>}
                {bulkPapers.length > 0 && <span style={{ color: C.dim, fontSize: 10 }}>{bulkPapers.length}</span>}
              </div>
            </div>

            {/* progress bar — folder by folder, with throttle countdown */}
            {bulkProgress && (
              <div style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, background: C.bg }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.muted, marginBottom: 4, fontFamily: mono }}>
                  <span>{bulkProgress.completedFolders}/{bulkProgress.totalFolders || 1} fld</span>
                  <span>{bulkProgress.completedPapers}/{bulkProgress.totalPapers} pdf</span>
                </div>
                <div style={{ height: 4, background: C.bar, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${bulkProgress.totalPapers > 0 ? (bulkProgress.completedPapers / bulkProgress.totalPapers) * 100 : 0}%`,
                    height: '100%',
                    background: bulkProgress.waitSeconds != null ? C.dim : C.barFill,
                    transition: 'width 0.2s ease',
                  }} />
                </div>
                {bulkProgress.waitSeconds != null ? (
                  <div style={{ fontSize: 10, color: C.orange, marginTop: 4, fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    ⏸ throttle · waiting {bulkProgress.waitSeconds}s (10/20s cap)…
                  </div>
                ) : bulkProgress.currentFolder ? (
                  <div style={{ fontSize: 9, color: C.dim, marginTop: 3, fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    → {bulkProgress.currentFolder || '(loose)'}
                  </div>
                ) : null}
              </div>
            )}

            {/* papers — grouped by folder when folders are present, flat otherwise */}
            {(() => {
              if (bulkPapers.length === 0) {
                return <div style={{ padding: 14, color: C.dim, fontSize: 11, textAlign: 'center' }}>—</div>
              }
              const hasFolders = bulkPapers.some(p => p.folders && p.folders.length > 0)
              if (!hasFolders) {
                return bulkPapers.map(p => renderRow(p, { showFolder: false }))
              }
              return classicsGroups.map(g => (
                <div key={g.folder || '__loose'}>
                  <div style={{ padding: '5px 9px', color: C.dim, fontSize: 9, background: C.bg, borderBottom: `1px solid ${C.border}`, fontFamily: mono, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: C.muted }}>{g.folder || '(loose)'}</span>
                    <span>·</span>
                    <span>{g.papers.length}</span>
                  </div>
                  {g.papers.map(p => renderRow(p, { showFolder: true }))}
                </div>
              ))
            })()}
          </div>
        )}
      </main>

      {/* selection bar */}
      {selecting && (
        <div style={{ background: C.surface, borderTop: `1px solid ${C.borderStrong}`, padding: '6px 8px', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0, zIndex: 10 }}>
          <span style={{ color: C.text, fontSize: 10 }}>{selected.size}·sel</span>
          <div style={{ flex: 1 }} />
          <button style={btnStyle()} disabled={selected.size === 0} onClick={() => bulkDownload(selectedPapers(allPapers()), 'loose')}>loose</button>
          <button style={btnStyle()} disabled={selected.size === 0} onClick={() => requestZip(selectedPapers(allPapers()))}>zip</button>
          <button style={btnStyle()} onClick={() => { setSelecting(false); setSelected(new Set()) }}>×</button>
        </div>
      )}

      {/* zip dialog */}
      {zipDialog && (
        <div style={{ position: 'fixed', inset: 0, background: C.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setZipDialog(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: R.row, padding: 12, display: 'flex', flexDirection: 'column', gap: 7, minWidth: 240, maxWidth: '90vw' }}>
            <div style={{ color: C.muted, fontSize: 10 }}>zip name</div>
            <input autoFocus value={zipName} onChange={e => setZipName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') confirmZip() }}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.borderStrong}`, padding: '5px 7px', fontSize: 11, borderRadius: R.btn, outline: 'none', fontFamily: mono }} />
            <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
              <button style={btnStyle()} onClick={() => setZipDialog(null)}>×</button>
              <button style={btnStyle(true)} onClick={confirmZip}>go</button>
            </div>
          </div>
        </div>
      )}

      {/* track modal */}
      {showTrack && (
        <div style={{ position: 'fixed', inset: 0, background: C.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setShowTrack(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: R.row, padding: 11, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 300, maxWidth: '90vw', maxHeight: '75vh', overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div style={{ color: C.muted, fontSize: 10 }}>track·{trackEntries.length}</div>
              <div style={{ flex: 1 }} />
              <button style={btnStyle()} onClick={async () => { const r = await fetch('/api/papers?action=track-backup').then(x => x.json()); if (r.zipUrl) openFile(r.zipUrl.split('file=')[1]) }}>backup</button>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              {trackEntries.map(t => (
                <div key={t.doi} style={{ padding: '5px 0', borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>
                  <div style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || t.doi}</div>
                  <div style={{ color: C.dim, fontSize: 9 }}>{t.doi}</div>
                </div>
              ))}
              {trackEntries.length === 0 && <div style={{ color: C.dim, fontSize: 11, padding: 14, textAlign: 'center' }}>—</div>}
            </div>
            <button style={{ ...btnStyle(true), marginTop: 3 }} onClick={() => setShowTrack(false)}>done</button>
          </div>
        </div>
      )}

      {toast && <div style={{ position: 'fixed', bottom: 12, left: '50%', transform: 'translateX(-50%)', background: C.text, color: '#fff', padding: '6px 12px', fontSize: 10, borderRadius: R.btn, zIndex: 100, maxWidth: '90vw' }}>{toast}</div>}
    </div>
  )
}

function parseDoi(s: string): string {
  const m = (s || '').match(/\b10\.\d{4,9}\/[^\s"<>]+/)
  if (!m) return ''
  return m[0].replace(/[.,;)]+$/, '')
}
