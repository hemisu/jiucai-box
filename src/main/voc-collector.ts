import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VocInboxItem, VocSource } from '../shared/voc'
import { extractDouyinProfileId } from '../shared/voc'
import { ensureVocSources, ingestVocInbox, updateVocSourceHealth } from './voc-store'
import { withVocPage } from './voc-browser-cdp'
import { cleanupVocMediaTemp, readVocMediaEvidence } from './voc-media-reader'

const root = () => join(process.env.TRADE_MASTER_HOME || join(homedir(), '.trade-master'), 'voc')
const statePath = () => join(root(), 'collector-state.json')
interface CollectorState {
  seenBySource: Record<string, string[]>
  completedBySource: Record<string, string[]>
  ignoredBySource: Record<string, string[]>
  checkedBySource: Record<string, string>
  artifactMissingRetryBySource: Record<string, string[]>
}
interface DiscoveredItem { contentId: string; url: string; hint?: string; pinned?: boolean }
interface DetailResult { time: string; text: string; mediaType: VocInboxItem['mediaType']; mediaUrl?: string; authorProfileId?: string; authorName?: string }

const readState = async (): Promise<CollectorState> => {
  let stored: Partial<CollectorState> = {}
  try { stored = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<CollectorState> }
  catch { /* initialize below */ }
  const state: CollectorState = {
    seenBySource: stored.seenBySource || {},
    completedBySource: stored.completedBySource || {},
    ignoredBySource: stored.ignoredBySource || {},
    checkedBySource: stored.checkedBySource || {},
    artifactMissingRetryBySource: stored.artifactMissingRetryBySource || {}
  }
  const files = (await readdir(join(root(), 'events'), { recursive: true }).catch(() => []))
    .filter((file) => file.endsWith('.json'))
  for (const file of files) {
    try {
      const event = JSON.parse(await readFile(join(root(), 'events', file), 'utf8')) as VocInboxItem
      const completed = state.completedBySource[event.sourceId] || []
      if (!completed.includes(event.contentId)) state.completedBySource[event.sourceId] = [...completed, event.contentId]
    } catch { /* ignore malformed historical files; ingestion will surface them separately */ }
  }
  return state
}
const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
const cleanText = (value?: string) => value?.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

const needsMediaRetry = async (sourceId: string, contentId: string) => {
  const filename = `${sourceId}-${contentId}.json`
  const candidates = [join(root(), 'inbox', filename)]
  const archived = (await readdir(join(root(), 'processed')).catch(() => []))
    .filter((name) => name.endsWith(filename)).sort().at(-1)
  if (archived) candidates.push(join(root(), 'processed', archived))
  for (const path of candidates) {
    try {
      const item = JSON.parse(await readFile(path, 'utf8')) as VocInboxItem
      return item.metadata?.mediaEvidenceStatus === 'failed'
    } catch { /* try the next candidate */ }
  }
  return false
}

const hasCollectedArtifact = async (sourceId: string, contentId: string) => {
  const filename = `${sourceId}-${contentId}.json`
  try { await readFile(join(root(), 'inbox', filename), 'utf8'); return true }
  catch { /* check archived files and events below */ }
  const archived = await readdir(join(root(), 'processed')).catch(() => [])
  if (archived.some((name) => name.endsWith(filename))) return true
  const eventFiles = (await readdir(join(root(), 'events'), { recursive: true }).catch(() => []))
    .filter((file) => file.endsWith('.json'))
  for (const file of eventFiles) {
    try {
      const event = JSON.parse(await readFile(join(root(), 'events', file), 'utf8')) as VocInboxItem
      if (event.sourceId === sourceId && event.contentId === contentId) return true
    } catch { /* malformed files are ignored by snapshot loading too */ }
  }
  return false
}

export const parsePlatformTime = (raw: string, now = new Date()): string | null => {
  const value = raw.replace(/^发布时间[:：]\s*/, '').trim()
  const full = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/)
  const short = value.match(/^(\d{2})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/)
  const today = value.match(/^今天\s+(\d{1,2}):(\d{2})/)
  const minutes = value.match(/^(\d+)分钟前$/)
  const build = (year: number, month: number, day: number, hour: number, minute: number) => {
    const date = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (full) return build(...full.slice(1).map(Number) as [number, number, number, number, number])
  if (short) return build(2000 + Number(short[1]), Number(short[2]), Number(short[3]), Number(short[4]), Number(short[5]))
  if (today) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number)
    return build(parts[0], parts[1], parts[2], Number(today[1]), Number(today[2]))
  }
  if (minutes) return new Date(now.getTime() - Number(minutes[1]) * 60_000).toISOString()
  return null
}

export const isWithinVocLookback = (publishedAt: string, cutoff = Date.now() - 24 * 60 * 60 * 1000) => {
  const timestamp = Date.parse(publishedAt)
  return Number.isFinite(timestamp) && timestamp >= cutoff
}

const profileScript = (platform: VocSource['platform']) => platform === 'weibo'
  ? `(() => Array.from(document.querySelectorAll('article')).map(article => {
      const link = Array.from(article.querySelectorAll('a[href]')).find(a => /\\/\\d+\\/[A-Za-z0-9]+(?:\\?|$)/.test(a.href));
      if (!link) return null;
      const match = link.href.match(/\\/(\\d+)\\/([A-Za-z0-9]+)/);
      return match ? { contentId: match[2], url: link.href.split('?')[0], hint: article.innerText.slice(0, 1500) } : null;
    }).filter(Boolean))()`
  : `(() => {
      const list = document.querySelector('[data-e2e="user-post-list"]');
      if (!list || !document.querySelector('[data-e2e="user-detail"]')) return [];
      return Array.from(list.querySelectorAll('a[href*="/video/"],a[href*="/note/"]')).map(link => {
        const match = link.href.match(/\\/(?:video|note)\\/(\\d+)/);
        const hint = (link.innerText || link.getAttribute('aria-label') || '').slice(0, 1500);
        return match ? { contentId: match[1], url: link.href.split('?')[0], hint, pinned: hint.includes('置顶') } : null;
      }).filter((item, index, all) => item && all.findIndex(candidate => candidate.contentId === item.contentId) === index);
    })()`

const weiboDetailScript = `(() => {
  const article = document.querySelector('article');
  if (!article) return null;
  const time = Array.from(article.querySelectorAll('a,span')).map(node => node.textContent.trim()).find(text => /^(?:\\d{2,4}-\\d{1,2}-\\d{1,2}|今天|\\d+分钟前)/.test(text)) || '';
  const video = article.querySelector('video');
  return { time, text: article.innerText.slice(0, 12000), mediaType: video ? 'video' : article.querySelector('img') ? 'post' : 'post', mediaUrl: video?.currentSrc || '' };
})()`

const douyinDetailScript = `(() => {
  const detail = document.querySelector('[data-e2e="video-detail"]');
  if (!detail) return null;
  const authorLink = detail.querySelector('[data-e2e="user-info"] a[href*="/user/"]') || detail.querySelector('a[href*="/user/"]');
  const authorMatch = authorLink?.href?.match(/\\/user\\/([^/?]+)/);
  if (!authorMatch) return null;
  const timeNode = detail.querySelector('[data-e2e="detail-video-publish-time"]');
  const description = document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content || '';
  return { time: timeNode?.textContent || '', text: description || document.title, mediaType: 'video', authorProfileId: authorMatch[1], authorName: (authorLink.innerText || '').trim().slice(0, 120) };
})()`

const douyinMediaUrlScript = `(() => {
  const video = document.querySelector('[data-e2e="video-detail"] video');
  const currentSrc = String(video?.currentSrc || '');
  const isHttp = url => url.startsWith('http://') || url.startsWith('https://');
  const networkMedia = performance.getEntriesByType('resource').map(entry => String(entry.name || '')).reverse().find(url =>
    isHttp(url) && ['douyinvod', 'bytevcloud', 'video/tos', 'mime_type=video', '.mp4'].some(token => url.toLowerCase().includes(token))
  ) || '';
  return isHttp(currentSrc) ? currentSrc : networkMedia;
})()`

const discover = async (source: VocSource): Promise<DiscoveredItem[]> => withVocPage(source.profileUrl!, async (page) => {
  const discovered = new Map<string, DiscoveredItem>()
  const limit = source.platform === 'douyin' ? 48 : 40
  let stableRounds = 0
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const before = discovered.size
    const items = await page.evaluate<DiscoveredItem[]>(profileScript(source.platform))
    for (const item of items || []) if (item?.contentId && !discovered.has(item.contentId)) discovered.set(item.contentId, item)
    stableRounds = discovered.size === before ? stableRounds + 1 : 0
    if (discovered.size >= limit || (discovered.size > 0 && stableRounds >= 3)) break
    await page.evaluate('(() => { const root = document.scrollingElement || document.documentElement; window.scrollTo(0, root.scrollHeight); return root.scrollHeight; })()')
    await new Promise((resolve) => setTimeout(resolve, source.platform === 'douyin' ? 900 : 700))
  }
  if (!discovered.size) throw new Error('没有读取到公开内容，请在专用采集浏览器中确认登录状态')
  return [...discovered.values()].sort((a, b) => Number(Boolean(a.pinned)) - Number(Boolean(b.pinned)))
}, { referer: source.profileUrl })

const readDetail = async (source: VocSource, item: DiscoveredItem, skipMediaBefore?: number): Promise<VocInboxItem | null> => withVocPage(item.url, async (page) => {
  let detail: DetailResult | null = null
  for (let attempt = 0; attempt < 16 && !detail; attempt += 1) {
    detail = await page.evaluate<DetailResult | null>(source.platform === 'weibo' ? weiboDetailScript : douyinDetailScript)
    if (!detail) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!detail) throw new Error('内容详情页结构发生变化')
  if (source.platform === 'douyin') {
    const expectedAuthor = extractDouyinProfileId(source.profileUrl)
    if (!expectedAuthor || detail.authorProfileId !== expectedAuthor) throw new Error('抖音视频作者与监控账号不一致，已拒绝采集')
    for (let attempt = 0; attempt < 8 && !detail.mediaUrl; attempt += 1) {
      const mediaUrl = await page.evaluate<unknown>(douyinMediaUrlScript)
      if (typeof mediaUrl === 'string' && mediaUrl.startsWith('http')) detail.mediaUrl = mediaUrl
      if (!detail.mediaUrl) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  const publishedAt = parsePlatformTime(detail.time)
  if (!publishedAt) throw new Error(`无法确认原始发布时间：${detail.time || '页面未提供'}`)
  const text = cleanText(detail.text) || cleanText(item.hint)
  if (!text) throw new Error('内容正文为空')
  const shouldAnalyzeMedia = !skipMediaBefore || Date.parse(publishedAt) >= skipMediaBefore
  const media = shouldAnalyzeMedia && process.env.VOC_MEDIA_ANALYSIS !== '0' && detail.mediaType === 'video' && detail.mediaUrl ? await readVocMediaEvidence(detail.mediaUrl, item.url) : null
  return {
    schemaVersion: 1, sourceId: source.id, platform: source.platform, contentId: item.contentId,
    publishedAt, capturedAt: new Date().toISOString(), url: item.url, mediaType: detail.mediaType,
    text, transcript: media?.transcript, metadata: {
      collector: 'chrome-cdp-v2', authorProfileId: detail.authorProfileId, authorName: detail.authorName,
      screenText: media?.screenText, transcriptSegments: media?.transcriptSegments,
      transcriptQuality: media?.transcriptQuality, asrModel: media?.asrModel,
      mediaEvidenceStatus: media?.status || (detail.mediaType === 'video' ? 'missing_media_url' : 'not_required'), mediaEvidenceError: media?.error
    }
  }
}, { referer: source.profileUrl, warmupUrl: source.profileUrl })

const collectSource = async (source: VocSource, state: CollectorState) => {
  const discovered = await discover(source)
  const seen = new Set(state.seenBySource[source.id] || [])
  const completed = new Set(state.completedBySource[source.id] || [])
  const ignored = new Set(state.ignoredBySource[source.id] || [])
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const retryable = new Set<string>()
  const artifactMissingRetried = new Set(state.artifactMissingRetryBySource[source.id] || [])
  for (const item of discovered) {
    if (!completed.has(item.contentId)) continue
    if (await needsMediaRetry(source.id, item.contentId)) retryable.add(item.contentId)
    else if (!artifactMissingRetried.has(item.contentId) && !await hasCollectedArtifact(source.id, item.contentId)) retryable.add(item.contentId)
  }
  const candidates = discovered.filter((item) => (!completed.has(item.contentId) || retryable.has(item.contentId)) && !ignored.has(item.contentId))
  let consecutiveOlder = 0
  let stopRegularItems = false
  const errors: string[] = []
  const orderedCandidates = [...candidates.filter((item) => !item.pinned), ...candidates.filter((item) => item.pinned)]
  for (const item of orderedCandidates) {
    if (stopRegularItems && !item.pinned) continue
    try {
      const content = await readDetail(source, item, cutoff)
      if (!content) continue
      if (completed.has(item.contentId) && !artifactMissingRetried.has(item.contentId)) artifactMissingRetried.add(item.contentId)
      completed.add(item.contentId)
      if (isWithinVocLookback(content.publishedAt, cutoff)) {
        await writeJson(join(root(), 'inbox', `${source.id}-${item.contentId}.json`), content)
        consecutiveOlder = 0
      } else consecutiveOlder += 1
      if (consecutiveOlder >= 3 && !item.pinned) stopRegularItems = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('作者与监控账号不一致')) ignored.add(item.contentId)
      else errors.push(`${item.contentId}: ${message}`)
    }
  }
  state.seenBySource[source.id] = [...new Set([...discovered.map((item) => item.contentId), ...seen])].slice(0, 100)
  state.completedBySource[source.id] = [...completed].slice(-100)
  state.ignoredBySource[source.id] = [...ignored].slice(-100)
  state.artifactMissingRetryBySource[source.id] = [...artifactMissingRetried].slice(-100)
  state.checkedBySource[source.id] = new Date().toISOString()
  await updateVocSourceHealth(source.id, { status: errors.length ? 'error' : 'ready', lastCheckedAt: state.checkedBySource[source.id], lastError: errors.length ? `24 小时回溯跳过 ${errors.length} 条：${errors.slice(0, 2).join('；')}` : undefined })
}

const backfillSource = async (source: VocSource, state: CollectorState, cutoff: number) => {
  const discovered = await discover(source)
  const seen = new Set(state.seenBySource[source.id] || [])
  const completed = new Set(state.completedBySource[source.id] || [])
  const ignored = new Set(state.ignoredBySource[source.id] || [])
  let collected = 0
  let inspected = 0
  let consecutiveOlder = 0
  let stopRegularItems = false
  const errors: string[] = []
  const candidates = discovered.filter((item) => !ignored.has(item.contentId))
  const orderedCandidates = [...candidates.filter((item) => !item.pinned), ...candidates.filter((item) => item.pinned)]
  for (const item of orderedCandidates) {
    seen.add(item.contentId)
    if (completed.has(item.contentId) || (stopRegularItems && !item.pinned)) continue
    try {
      const content = await readDetail(source, item, cutoff)
      if (!content) continue
      inspected += 1
      completed.add(item.contentId)
      if (isWithinVocLookback(content.publishedAt, cutoff)) {
        await writeJson(join(root(), 'inbox', `${source.id}-${item.contentId}.json`), content)
        collected += 1
        consecutiveOlder = 0
      } else consecutiveOlder += 1
      state.seenBySource[source.id] = [...seen].slice(-100)
      state.completedBySource[source.id] = [...completed].slice(-100)
      state.ignoredBySource[source.id] = [...ignored].slice(-100)
      await writeJson(statePath(), state)
      if (consecutiveOlder >= 3 && !item.pinned) stopRegularItems = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('作者与监控账号不一致')) ignored.add(item.contentId)
      else errors.push(`${item.contentId}: ${message}`)
    }
  }
  state.seenBySource[source.id] = [...seen].slice(-100)
  state.completedBySource[source.id] = [...completed].slice(-100)
  state.ignoredBySource[source.id] = [...ignored].slice(-100)
  state.checkedBySource[source.id] = new Date().toISOString()
  const lastError = errors.length ? `历史回溯跳过 ${errors.length} 条：${errors.slice(0, 2).join('；')}` : undefined
  await updateVocSourceHealth(source.id, { status: collected || !errors.length ? 'ready' : 'error', lastCheckedAt: state.checkedBySource[source.id], lastError })
  return { sourceId: source.id, discovered: discovered.length, inspected, collected, errors }
}

let timer: NodeJS.Timeout | null = null
let busy = false
export const runVocCollectorOnce = async () => {
  if (busy) return
  busy = true
  const state = await readState()
  try {
    const sources = (await ensureVocSources()).filter((source) => source.enabled && source.profileUrl && ['weibo', 'douyin'].includes(source.platform))
    for (const source of sources) {
      const last = Date.parse(state.checkedBySource[source.id] || '') || 0
      if (Date.now() - last < 3 * 60_000) continue
      try { await collectSource(source, state) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.checkedBySource[source.id] = new Date().toISOString()
        await updateVocSourceHealth(source.id, { status: 'error', lastCheckedAt: state.checkedBySource[source.id], lastError: message })
      }
      await writeJson(statePath(), state)
    }
  } finally { busy = false }
}

export const runVocBackfill = async (days = 3) => {
  if (busy) return { skipped: true, reason: 'collector_busy', results: [] }
  busy = true
  const state = await readState()
  const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000
  const results: Awaited<ReturnType<typeof backfillSource>>[] = []
  try {
    await cleanupVocMediaTemp()
    const sources = (await ensureVocSources()).filter((source) => source.enabled && source.profileUrl && ['weibo', 'douyin'].includes(source.platform))
    console.info(`[VOC] 开始回溯最近 ${days} 天，共 ${sources.length} 个账号`)
    for (const source of sources) {
      try {
        const result = await backfillSource(source, state, cutoff)
        results.push(result)
        console.info(`[VOC] ${source.displayName} 回溯完成：发现 ${result.discovered} 条，新增 ${result.collected} 条`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({ sourceId: source.id, discovered: 0, inspected: 0, collected: 0, errors: [message] })
        state.checkedBySource[source.id] = new Date().toISOString()
        await updateVocSourceHealth(source.id, { status: 'error', lastCheckedAt: state.checkedBySource[source.id], lastError: message })
        console.error(`[VOC] ${source.displayName} 回溯失败：${message}`)
      }
      await writeJson(statePath(), state)
    }
    return { skipped: false, cutoff: new Date(cutoff).toISOString(), results }
  } finally { busy = false }
}

export const reprocessVocSource = async (sourceId: string, days = 3, contentIds: string[] = []) => {
  if (busy) return { skipped: true, reason: 'collector_busy', collected: 0, errors: [] as string[] }
  busy = true
  const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000
  const errors: string[] = []
  let collected = 0
  try {
    await cleanupVocMediaTemp()
    const source = (await ensureVocSources()).find((item) => item.id === sourceId && item.enabled && item.profileUrl)
    if (!source) throw new Error('没有找到已启用且已绑定主页的 VOC 账号')
    const discovered = contentIds.length
      ? [...new Set(contentIds)].map((contentId) => ({ contentId, url: `https://www.douyin.com/video/${contentId}` }))
      : await discover(source)
    for (const item of discovered) {
      try {
        console.info(`[VOC] 正在重新识别 ${source.displayName} ${item.contentId}`)
        const content = await readDetail(source, item, cutoff)
        if (!content || !isWithinVocLookback(content.publishedAt, cutoff)) continue
        if (!content.transcript?.trim() || content.metadata?.transcriptQuality !== 'usable') {
          throw new Error(String(content.metadata?.mediaEvidenceError || '逐字稿质量未达到可用标准'))
        }
        content.metadata = { ...content.metadata, replaceExisting: true, reprocessedAt: new Date().toISOString() }
        await writeJson(join(root(), 'inbox', `${source.id}-${item.contentId}.json`), content)
        const ingestion = await ingestVocInbox()
        if (ingestion.errors.length) throw new Error(ingestion.errors.join('；'))
        collected += 1
        console.info(`[VOC] 已更新 ${source.displayName} ${item.contentId}`)
      } catch (error) {
        const message = `${item.contentId}: ${error instanceof Error ? error.message : String(error)}`
        errors.push(message)
        console.error(`[VOC] 重识别失败 ${message}`)
      }
    }
    return { skipped: false, discovered: discovered.length, collected, errors }
  } finally { busy = false }
}

export const startVocCollector = () => {
  if (timer) return
  void cleanupVocMediaTemp().finally(() => setTimeout(() => void runVocCollectorOnce(), 4_000))
  timer = setInterval(() => void runVocCollectorOnce(), 60_000)
}
export const stopVocCollector = () => { if (timer) clearInterval(timer); timer = null }
