import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, shell, Tray } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sendAiMessage } from './ai-provider'
import { loadAiConfig, saveAiConfig } from './ai-config-store'
import { appendChatSessionMessage, createChatSession, listChatSessions, loadChatSession, onChatSessionChanged, saveChatSession, setChatSessionArchived } from './chat-store'
import { cancelChatRun, finishChatRun, getChatRun, listChatRuns, startChatRun, updateChatRun } from './chat-run-service'
import { createStrategyCandidate } from './strategy-candidate'
import { loadTradeMasterSnapshot, runTradeMaster } from './trade-master'
import { buildTradeContext } from './trade-context'
import { saveUserProfile } from './profile-store'
import { addWatchItem, removeWatchItem } from './watchlist-store'
import { scanWatchlistOpportunities } from './watchlist-scan'
import { recordConfirmedTrade } from './portfolio-store'
import { inspectCandidatePromotion, rollbackStrategies, setStrategyState } from './strategy-store'
import { createAutomationTask, deleteAutomationTask, installAutomations, preserveCustomAutomations, setAutomationEnabled, updateAutomationTask } from './automation-store'
import { runAutomationTask, startAutomationScheduler, stopAutomationScheduler } from './automation-runner'
import { getDesktopStatus, installSwiftBar } from './desktop-integrations'
import type { AiStreamEvent, AttachmentInput, ChatRunSnapshot, ChatSessionSummary, HouseholdAccountInput, HouseholdMemberInput, Instrument, TradeRecordInput, WatchItem } from '../shared/types'
import type { PositionStrategyRequest } from '../shared/position-strategy'
import { discardAttachment, importAttachmentFiles, resolveAttachmentPath, saveAttachmentBytes } from './attachment-store'
import { prepareDependencies } from './setup-service'
import { checkForAppUpdates, getUpdateStatus, onUpdateStatus, restartToUpdate } from './app-updater'
import { cancelFeishuAuthorization, completeFeishuAuthorization, configureFeishuGroup, connectFeishu, getFeishuAuthorizationUrl, searchFeishuChats } from './feishu-connection'
import { getFeishuConversationStatus, onFeishuConversationStatus, restartFeishuConversationService, startFeishuConversationService, stopFeishuConversationService } from './feishu-conversation'
import { generateMarketInsight } from './market-insight'
import { generatePositionStrategy } from './position-strategy'
import type { MarketInsightRequest } from '../shared/types'
import { buildMemoryContext, canGenerateMemories, createMemory, deleteMemory, loadMemories, saveMemoryCandidates, saveMemorySettings, updateMemory } from './memory-store'
import { extractMemoryCandidates } from './memory-extractor'
import { createHouseholdAccount, createHouseholdMember, PRIMARY_ACCOUNT_ID, recordManagedHouseholdTrade, updateHouseholdAccount, updateHouseholdMember } from './household-store'
import { STOCK_CARD_INSTRUCTION } from './stock-card-prompt'
import { rolloverAvailableQuantitiesBeforeOpen } from './position-session-rollover'
import type { AutomationTaskInput } from '../shared/automation-schedule'
import { importVocSources, updateVocSource } from './voc-store'
import { openVocLoginBrowser, stopVocBrowser } from './voc-browser-cdp'
import { startVocCollector, stopVocCollector } from './voc-collector'
import { confirmNormalDiscipline } from './discipline-store'
import { MULTI_ACCOUNT_OUTPUT_INSTRUCTION } from '../shared/account-separation'

protocol.registerSchemesAsPrivileged([{ scheme: 'jiucai-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const APP_NAME = '韭菜盒子'
const appIconPath = () => join(app.getAppPath(), 'resources/icon.png')

app.setName(APP_NAME)

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

const broadcastChatRun = (sessionId: string, run: ChatRunSnapshot | null) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('ai:chat:run-changed', { sessionId, run })
  }
}

const broadcastChatSessionChanged = (session: ChatSessionSummary) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('chat-sessions:changed', session)
  }
}

const chatTimeLabel = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

const trayIcon = () => nativeImage.createFromDataURL(
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cGF0aCBmaWxsPSIjMDAwIiBkPSJNOSAxN2MtLjYgMC0xLS40LTEtMVY5LjRjLTMuNi0uNS02LTItNy00LjRWNGMuMS0uNS41LS44IDEtLjggMi44LjEgNC44LjggNiAyLjJDMTAgMy4xIDEyLjQgMiAxNiAyYy41IDAgMSAuNCAxIDF2LjZjLS4yIDMuNS0yLjYgNS42LTcgNS44VjE2YzAgLjYtLjQgMS0xIDFabS00LjctMTJjLjguNyAyIDEuMiAzLjcgMS40QzcuMiA1LjcgNiA1LjIgNC4zIDVaTTEwIDcuNGMyLjEtLjMgMy42LTEuMyA0LjMtMy4zLTItLjEtMy40LjktNC4zIDMuM1oiLz48L3N2Zz4='
)

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#f7f7f5',
    title: APP_NAME,
    icon: appIconPath(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

const createTray = (): void => {
  tray = new Tray(trayIcon())
  tray.setToolTip(`${APP_NAME} · 安心交易助手`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `打开${APP_NAME}`, click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: '盘前策略', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('navigate', 'chat') } },
    { label: '家庭持仓', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('navigate', 'portfolio') } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
}

const registerIpc = (): void => {
  ipcMain.handle('trade-master:load', () => loadTradeMasterSnapshot())
  ipcMain.handle('discipline:confirm-normal', async () => {
    try { return { ok: true, discipline: await confirmNormalDiscipline() } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('trade-master:run', async (_event, command: string, args: string[] = []) => {
    try { return { ok: true, output: await runTradeMaster(command, args) } }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('ai:chat:list-runs', () => listChatRuns())
  ipcMain.handle('ai:chat:cancel', (_event, sessionId: string) => {
    const cancelled = cancelChatRun(sessionId)
    if (cancelled) broadcastChatRun(sessionId, getChatRun(sessionId))
    return cancelled
  })
  ipcMain.handle('ai:chat', async (_ipcEvent, requestId: string, config, sessionId: string, messages) => {
    let active: ReturnType<typeof startChatRun>
    try {
      active = startChatRun(requestId, sessionId)
      broadcastChatRun(sessionId, active.snapshot)
    } catch (error) {
      return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) }
    }
    const emit = (event: AiStreamEvent) => {
      const run = updateChatRun(sessionId, event)
      if (run) broadcastChatRun(sessionId, run)
    }
    try {
      emit({ type: 'status', stage: 'connecting', message: '正在连接 AI' })
      const [savedConfig, snapshot, session] = await Promise.all([
        loadAiConfig(),
        loadTradeMasterSnapshot(),
        loadChatSession(sessionId).catch(() => null)
      ])
      const resolvedConfig = { ...savedConfig, ...config, apiKey: config.apiKey ?? savedConfig.apiKey }
      const writeCapability = resolvedConfig.provider === 'codex-local'
        ? '当前使用本机 Codex，可在 fact_home 工作目录内修改本地交易 JSON；修改家庭持仓必须严格遵守 household_write_rules，写完要验证 JSON 并说明实际改动。'
        : '当前 AI 渠道没有本地文件写入能力；可以教用户去“家庭持仓 → 记一笔成交”录入，或给出应写入的 JSON，但不得声称已经修改文件。'
      const context = { role: 'system', content: `以下是用户当前确认过的交易记录。只能基于这些记录回答；缺失或冲突必须明确说“需要确认”，不得把已经结束的历史交易当成当前持仓。家庭持仓必须按成员和账户分别分析，不能合并不同人的成本、数量和策略；portfolio 与 household_portfolios 中 source=primary 是同一主账户，只计算一次。${MULTI_ACCOUNT_OUTPUT_INSTRUCTION} daily_account_state 是当前交易日已确认状态，已确认字段不得重复询问或重新标成待确认，只能指出仍缺失的单独字段。${writeCapability}\n${buildTradeContext(snapshot)}` }
      const stockCardContext = { role: 'system', content: STOCK_CARD_INSTRUCTION }
      const latestQuestion = [...messages].reverse().find((message) => message.role === 'user')?.content || ''
      const memory = await buildMemoryContext(latestQuestion, session?.memories)
      const memoryContext = memory ? [{ role: 'system', content: memory }] : []
      emit({ type: 'status', stage: 'thinking', message: memory ? '交易记录和相关记忆已读取，正在分析' : '交易记录已读取，正在分析' })
      const content = await sendAiMessage(resolvedConfig, [context, stockCardContext, ...memoryContext, ...messages], {
        purpose: 'chat', onEvent: emit, signal: active.controller.signal, workingDirectory: snapshot.home
      })
      await appendChatSessionMessage(sessionId, { id: requestId, role: 'assistant', content, timestamp: chatTimeLabel(), status: 'normal' })
      return { ok: true, content, messageId: requestId }
    } catch (error) {
      const run = getChatRun(sessionId)
      const partial = run?.content.trim() || ''
      const cancelled = active.controller.signal.aborted
      const detail = error instanceof Error ? error.message : String(error)
      const content = cancelled
        ? `${partial}${partial ? '\n\n' : ''}已停止生成。`
        : `${partial}${partial ? '\n\n' : ''}发送失败：${detail}。你的持仓记录没有变化。`
      await appendChatSessionMessage(sessionId, { id: requestId, role: 'assistant', content, timestamp: chatTimeLabel(), status: cancelled ? 'notice' : 'error' }).catch(() => undefined)
      return { ok: false, content, messageId: requestId, cancelled, error: cancelled ? '已停止生成' : detail }
    }
    finally {
      finishChatRun(sessionId)
      broadcastChatRun(sessionId, null)
    }
  })
  ipcMain.handle('ai:market-insight', async (_event, request: MarketInsightRequest) => {
    try {
      const [config, snapshot] = await Promise.all([loadAiConfig(), loadTradeMasterSnapshot()])
      return { ok: true, insight: await generateMarketInsight(config, request, buildTradeContext(snapshot)) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('ai:position-strategy', async (_event, request: PositionStrategyRequest) => {
    try {
      const [config, snapshot] = await Promise.all([loadAiConfig(), loadTradeMasterSnapshot()])
      return { ok: true, ...await generatePositionStrategy(config, snapshot, request) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('attachments:pick', async (_event, sessionId: string) => {
    try {
      const options = {
        title: '添加图片或文件', properties: ['openFile', 'multiSelections'],
        filters: [{ name: '支持的附件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'json', 'csv', 'tsv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'js', 'ts', 'tsx', 'py', 'sql'] }, { name: '所有文件', extensions: ['*'] }]
      } as Electron.OpenDialogOptions
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      if (result.canceled) return { ok: true, attachments: [] }
      return { ok: true, attachments: await importAttachmentFiles(sessionId, result.filePaths) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('attachments:clipboard', async (_event, sessionId: string, input: AttachmentInput) => {
    try { return { ok: true, attachment: await saveAttachmentBytes(sessionId, input) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('attachments:discard', (_event, storageKey: string) => discardAttachment(storageKey))
  ipcMain.handle('ai:config:load', () => loadAiConfig())
  ipcMain.handle('ai:config:save', (_event, config) => saveAiConfig(config))
  ipcMain.handle('chat-sessions:list', (_event, archived: boolean) => listChatSessions(archived))
  ipcMain.handle('chat-sessions:create', () => createChatSession())
  ipcMain.handle('chat-sessions:load', (_event, id: string) => loadChatSession(id))
  ipcMain.handle('chat-sessions:save', (_event, session) => saveChatSession(session))
  ipcMain.handle('chat-sessions:set-archived', (_event, id: string, archived: boolean) => setChatSessionArchived(id, archived))
  ipcMain.handle('memories:load', () => loadMemories())
  ipcMain.handle('memories:save-settings', (_event, settings) => saveMemorySettings(settings))
  ipcMain.handle('memories:create', (_event, input) => createMemory(input))
  ipcMain.handle('memories:update', (_event, id: string, patch) => updateMemory(id, patch))
  ipcMain.handle('memories:delete', (_event, id: string) => deleteMemory(id))
  ipcMain.handle('memories:extract', async (_event, config, sessionId: string, messages) => {
    try {
      const session = await loadChatSession(sessionId).catch(() => null)
      if (!await canGenerateMemories(session?.memories)) return { ok: true, added: 0 }
      const savedConfig = await loadAiConfig()
      const resolvedConfig = { ...savedConfig, ...config, apiKey: config.apiKey ?? savedConfig.apiKey }
      const candidates = await extractMemoryCandidates(resolvedConfig, messages)
      return { ok: true, added: await saveMemoryCandidates(candidates, sessionId) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('profile:save', async (_event, profile) => {
    await runTradeMaster('init')
    return saveUserProfile(profile)
  })
  ipcMain.handle('setup:prepare', async (ipcEvent, requestId: string) => prepareDependencies((progress) => {
    if (!ipcEvent.sender.isDestroyed()) ipcEvent.sender.send('setup:progress', { requestId, progress })
  }))
  ipcMain.handle('watchlist:search', async (_event, query: string) => {
    const normalizedQuery = query?.trim()
    if (!normalizedQuery) return { ok: true, items: [] }
    if (normalizedQuery.length > 30) return { ok: false, error: '搜索内容不能超过 30 个字符' }
    try {
      const result = JSON.parse(await runTradeMaster('market', ['search', '--query', normalizedQuery])) as Instrument[]
      const items = result.filter((item) => /^\d{6}$/.test(item.code) && item.name && ['stock', 'etf', 'cbond'].includes(item.type) && ['SH', 'SZ', 'BJ'].includes(item.exchange))
      return { ok: true, items: [...new Map(items.map((item) => [item.code, item])).values()].slice(0, 8) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('watchlist:add', async (_event, code: string) => {
    if (!/^\d{6}$/.test(code)) return { ok: false, error: '请输入 6 位证券代码' }
    try {
      const info = JSON.parse(await runTradeMaster('market', ['info', '--code', code])) as { code: string; name: string; type: string; exchange: string }
      if (!['stock', 'etf', 'cbond'].includes(info.type) || !['SH', 'SZ', 'BJ'].includes(info.exchange)) throw new Error('行情源返回了不支持的标的类型')
      await addWatchItem({ code: info.code, name: info.name, type: info.type as 'stock' | 'etf' | 'cbond', exchange: info.exchange as 'SH' | 'SZ' | 'BJ' })
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('watchlist:remove', async (_event, code: string) => {
    try { await removeWatchItem(code); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('watchlist:scan', async (_event, liveItems: WatchItem[] = []) => {
    return scanWatchlistOpportunities(liveItems)
  })
  ipcMain.handle('voc:source:update', async (_event, id: string, patch) => {
    try { return { ok: true, source: await updateVocSource(id, patch) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('voc:sources:import', async (_event, raw: string) => {
    try { return { ok: true, ...await importVocSources(raw) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('voc:browser:login', async () => {
    try { return { ok: await openVocLoginBrowser() } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('portfolio:record', async (_event, trade: TradeRecordInput) => {
    if (!/^\d{6}$/.test(trade.code)) return { ok: false, error: '请输入 6 位证券代码' }
    try {
      const info = JSON.parse(await runTradeMaster('market', ['info', '--code', trade.code])) as Instrument
      if (!info.name || !['stock', 'etf', 'cbond'].includes(info.type)) throw new Error('无法确认标的信息')
      await recordConfirmedTrade(trade, info)
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('household:member:create', async (_event, input: HouseholdMemberInput) => {
    try { return { ok: true, member: await createHouseholdMember(input) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('household:account:create', async (_event, input: HouseholdAccountInput) => {
    try { return { ok: true, account: await createHouseholdAccount(input) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('household:member:update', async (_event, id: string, patch) => {
    try { return { ok: true, member: await updateHouseholdMember(id, patch) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('household:account:update', async (_event, id: string, patch) => {
    try { return { ok: true, account: await updateHouseholdAccount(id, patch) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('household:trade:record', async (_event, accountId: string, trade: TradeRecordInput) => {
    if (!/^\d{6}$/.test(trade.code)) return { ok: false, error: '请输入 6 位证券代码' }
    try {
      const info = JSON.parse(await runTradeMaster('market', ['info', '--code', trade.code])) as Instrument
      if (!info.name || !['stock', 'etf', 'cbond'].includes(info.type)) throw new Error('无法确认标的信息')
      if (accountId === PRIMARY_ACCOUNT_ID) await recordConfirmedTrade(trade, info)
      else await recordManagedHouseholdTrade(accountId, trade, info)
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('strategy:create-candidate', async (_event, config, prompt: string) => {
    if (!prompt?.trim() || prompt.length > 2000) return { ok: false, error: '策略描述不能为空且不能超过 2000 字' }
    try {
      const [savedConfig, snapshot] = await Promise.all([loadAiConfig(), loadTradeMasterSnapshot()])
      const resolvedConfig = { ...savedConfig, ...config, apiKey: config.apiKey ?? savedConfig.apiKey }
      return { ok: true, ...await createStrategyCandidate(resolvedConfig, prompt.trim(), buildTradeContext(snapshot)) }
    }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('strategy:set-status', async (_event, id: string, action: 'pause' | 'enable' | 'promote') => {
    try {
      if (action !== 'promote') {
        await setStrategyState(id, action)
        return { ok: true, changed: true, message: action === 'pause' ? '规则已暂停，并保留了恢复点。' : '规则已恢复使用。' }
      }
      const readiness = await inspectCandidatePromotion(id)
      if (!readiness.ready) return { ok: true, changed: false, promoted: false, message: readiness.message }
      const result = JSON.parse(await runTradeMaster('refine', ['--candidate', readiness.file])) as { promoted?: boolean; checks?: Array<{ name?: string; passed?: boolean }> }
      if (result.promoted) return { ok: true, changed: true, promoted: true, message: '全部验证门槛通过，规则已开始使用，并保留了恢复点。' }
      const failed = (result.checks || []).filter((check) => !check.passed).map((check) => String(check.name || '未知门槛'))
      return { ok: true, changed: false, promoted: false, message: `验证已完成，证据还不够${failed.length ? `：${failed.join('、')}` : ''}。正在使用的策略未修改。` }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const errorMessage = /history_samples|Cannot read properties of undefined/.test(detail) ? '这条待验证规则还是旧版数据，缺少完整验证证据；正在使用的策略未修改。' : detail
      return { ok: false, changed: false, error: errorMessage }
    }
  })
  ipcMain.handle('strategy:rollback', async () => {
    try { await rollbackStrategies(); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('automation:install', async () => {
    try { await installAutomations(); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('automation:restore-defaults', async () => {
    try {
      await preserveCustomAutomations(() => runTradeMaster('automation', ['plan', '--preset', 'standard']))
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('automation:create', async (_event, input: AutomationTaskInput) => {
    try { const task = await createAutomationTask(input); return { ok: true, id: task.id } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('automation:update', async (_event, id: string, input: AutomationTaskInput) => {
    try { await updateAutomationTask(id, input); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('automation:delete', async (_event, id: string) => {
    try { await deleteAutomationTask(id); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('automation:enabled', async (_event, id: string, enabled: boolean) => {
    try { await setAutomationEnabled(id, enabled); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('automation:run', async (_event, id: string) => {
    try {
      const run = await runAutomationTask(id)
      return run.status === 'failed' ? { ok: false, run, error: run.error } : { ok: true, run }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('notifications:connect-feishu', async () => {
    const result = await connectFeishu()
    if (result.ok && result.status === 'connected') void restartFeishuConversationService()
    return result
  })
  ipcMain.handle('notifications:search-feishu-chats', (_event, query: string) => searchFeishuChats(query))
  ipcMain.handle('notifications:configure-feishu-group', async (_event, chatId: string, name: string) => {
    const result = await configureFeishuGroup(chatId, name)
    if (result.ok && result.status === 'connected') void restartFeishuConversationService()
    return result
  })
  ipcMain.handle('notifications:complete-feishu-authorization', async (_event, authorizationId: string) => {
    const result = await completeFeishuAuthorization(authorizationId)
    if (result.ok && result.status === 'connected') void restartFeishuConversationService()
    return result
  })
  ipcMain.handle('notifications:conversation-status', () => getFeishuConversationStatus())
  ipcMain.handle('notifications:conversation-restart', () => restartFeishuConversationService())
  ipcMain.handle('notifications:open-feishu-authorization', async (_event, authorizationId: string) => {
    const url = getFeishuAuthorizationUrl(authorizationId)
    if (!url) return false
    await shell.openExternal(url)
    return true
  })
  ipcMain.handle('notifications:cancel-feishu-authorization', (_event, authorizationId: string) => {
    cancelFeishuAuthorization(authorizationId)
    return true
  })
  ipcMain.handle('notifications:test-feishu', async () => {
    try {
      await runTradeMaster('notify', ['feishu', '--mode', 'interactive', '--severity', 'info', '--title', '韭菜盒子通知测试', '--summary', '飞书通知链路已连接', '--fingerprint', `jiucai-box-test-${Date.now()}`])
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('desktop:status', () => getDesktopStatus())
  ipcMain.handle('desktop:install-swiftbar', async () => {
    try { return { ok: true, path: await installSwiftBar() } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('updates:status', () => getUpdateStatus())
  ipcMain.handle('updates:check', () => checkForAppUpdates())
  ipcMain.handle('updates:restart', () => { restartToUpdate(); return true })
  ipcMain.handle('system:notify', (_event, title: string, body: string) => {
    if (!Notification.isSupported()) return false
    new Notification({ title, body }).show()
    return true
  })
  ipcMain.handle('system:open-path', (_event, path: string) => shell.openPath(path))
  ipcMain.handle('system:open-external', async (_event, input: string) => {
    try {
      const url = new URL(input)
      const allowedHosts = new Set(['open.feishu.cn', 'weibo.com', 'www.weibo.com', 'douyin.com', 'www.douyin.com'])
      if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) return false
      await shell.openExternal(url.toString())
      return true
    } catch { return false }
  })
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath())
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })
  protocol.handle('jiucai-asset', (request) => {
    try {
      const url = new URL(request.url)
      const storageKey = decodeURIComponent(url.pathname.replace(/^\//, ''))
      return net.fetch(pathToFileURL(resolveAttachmentPath(storageKey)).toString())
    } catch { return new Response('附件不存在', { status: 404 }) }
  })
  registerIpc()
  onChatSessionChanged(broadcastChatSessionChanged)
  createWindow()
  onUpdateStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:status-changed', status)
  })
  onFeishuConversationStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('notifications:conversation-status-changed', status)
  })
  setTimeout(() => void checkForAppUpdates().catch(() => undefined), 5000)
  createTray()
  await runTradeMaster('automation', ['sync-defaults']).catch(() => undefined)
  await rolloverAvailableQuantitiesBeforeOpen().catch(() => undefined)
  startAutomationScheduler()
  startVocCollector()
  void startFeishuConversationService()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 ? createWindow() : mainWindow?.show())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  stopAutomationScheduler()
  stopVocCollector()
  stopVocBrowser()
  stopFeishuConversationService()
})
