import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DailyAccountState, HouseholdAccount, HouseholdAccountInput, HouseholdMember, HouseholdMemberInput, HouseholdPosition, HouseholdSnapshot, Instrument, TradeRecordInput } from '../shared/types'

interface StoredAccount extends HouseholdAccount { events?: Array<Record<string, unknown>> }
interface StoredHousehold { version: 1; members: HouseholdMember[]; accounts: StoredAccount[]; updatedAt: string }
interface PrimaryPortfolio { cash?: number | null; total_asset?: number | null; total_asset_estimate_before_unconfirmed_fees?: number | null; positions?: Array<Record<string, unknown>> }

export const OWNER_MEMBER_ID = 'self'
export const PRIMARY_ACCOUNT_ID = 'primary-account'
const home = () => process.env.TRADE_MASTER_HOME || join(homedir(), '.trade-master')
const targetPath = () => join(home(), 'household/portfolio.json')
let mutationQueue: Promise<void> = Promise.resolve()

const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

const now = () => new Date().toISOString()
const clean = (value: string, max = 40) => value.replace(/\s+/g, ' ').trim().slice(0, max)
const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id)
const atomicWrite = async (target: string, value: unknown) => {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(`${target}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(`${target}.tmp`, target)
}

const defaults = (): StoredHousehold => {
  const timestamp = now()
  return {
    version: 1,
    members: [{ id: OWNER_MEMBER_ID, name: '我', relationship: '本人', riskProfile: 'balanced', monitoringEnabled: true, isOwner: true, createdAt: timestamp, updatedAt: timestamp }],
    accounts: [{ id: PRIMARY_ACCOUNT_ID, memberId: OWNER_MEMBER_ID, name: '我的主账户', source: 'primary', totalAsset: null, cash: null, monitoringEnabled: true, positions: [], updatedAt: timestamp }],
    updatedAt: timestamp
  }
}

const loadStored = async (): Promise<StoredHousehold> => {
  let state = defaults()
  try { state = JSON.parse(await readFile(targetPath(), 'utf8')) as StoredHousehold }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const fallback = defaults()
  const members = Array.isArray(state.members) ? state.members.filter((member) => validId(member.id) && clean(member.name)) : []
  if (!members.some((member) => member.id === OWNER_MEMBER_ID)) members.unshift(fallback.members[0])
  const memberIds = new Set(members.map((member) => member.id))
  const accounts = Array.isArray(state.accounts) ? state.accounts.filter((account) => validId(account.id) && memberIds.has(account.memberId)) : []
  if (!accounts.some((account) => account.id === PRIMARY_ACCOUNT_ID)) accounts.unshift(fallback.accounts[0])
  return { version: 1, members, accounts, updatedAt: state.updatedAt || fallback.updatedAt }
}

const primaryPositions = (portfolio: unknown): HouseholdPosition[] => {
  const raw = portfolio as PrimaryPortfolio | null
  return (raw?.positions || []).flatMap((position) => {
    const nested = position.instrument as Partial<Instrument> | undefined
    const code = String(nested?.code || position.code || '').trim()
    const name = String(nested?.name || position.name || '').trim()
    if (!/^\d{6}$/.test(code) || !name) return []
    const rawType = nested?.type || position.instrument_type || position.instrumentType
    const rawExchange = nested?.exchange || position.exchange
    const averageCost = position.average_cost ?? position.averageCost ?? position.cost_price ?? position.costPrice ?? position.cost
    return [{
      instrument: {
        code,
        name,
        type: rawType === 'etf' || rawType === 'cbond' ? rawType : 'stock',
        exchange: rawExchange === 'SZ' || rawExchange === 'BJ' ? rawExchange : 'SH'
      },
      quantity: Number(position.quantity || 0),
      availableQuantity: Number(position.available_quantity ?? position.availableQuantity ?? 0),
      averageCost: typeof averageCost === 'number' ? averageCost : null,
      status: position.status === 'closed' ? 'closed' : position.status === 'pending' ? 'pending' : 'confirmed'
    }]
  })
}

export const loadHousehold = async (primaryPortfolio?: unknown, accountState?: DailyAccountState | null): Promise<HouseholdSnapshot> => {
  const state = await loadStored()
  const raw = primaryPortfolio as PrimaryPortfolio | null
  return {
    members: state.members,
    accounts: state.accounts.map((account) => account.id === PRIMARY_ACCOUNT_ID ? {
      ...account,
      totalAsset: raw?.total_asset ?? raw?.total_asset_estimate_before_unconfirmed_fees ?? account.totalAsset,
      cash: accountState?.availableCash?.value ?? raw?.cash ?? account.cash,
      positions: primaryPositions(primaryPortfolio)
    } : account),
    updatedAt: state.updatedAt
  }
}

export const createHouseholdMember = async (input: HouseholdMemberInput): Promise<HouseholdMember> => mutate(async () => {
  const name = clean(input.name)
  const relationship = clean(input.relationship || '家人', 20)
  if (!name) throw new Error('成员姓名不能为空')
  if (!['conservative', 'balanced', 'active'].includes(input.riskProfile)) throw new Error('风险偏好无效')
  const state = await loadStored()
  if (state.members.some((member) => member.name === name && member.relationship === relationship)) throw new Error('这个家庭成员已经存在')
  const timestamp = now()
  const member: HouseholdMember = { id: randomUUID(), name, relationship, riskProfile: input.riskProfile, monitoringEnabled: true, isOwner: false, createdAt: timestamp, updatedAt: timestamp }
  await atomicWrite(targetPath(), { ...state, members: [...state.members, member], updatedAt: timestamp })
  return member
})

export const createHouseholdAccount = async (input: HouseholdAccountInput): Promise<HouseholdAccount> => mutate(async () => {
  const state = await loadStored()
  if (!state.members.some((member) => member.id === input.memberId)) throw new Error('家庭成员不存在')
  const name = clean(input.name)
  if (!name) throw new Error('账户名称不能为空')
  if (input.totalAsset != null && (!Number.isFinite(input.totalAsset) || input.totalAsset < 0)) throw new Error('总资产不能小于 0')
  const timestamp = now()
  const account: HouseholdAccount = { id: randomUUID(), memberId: input.memberId, name, broker: clean(input.broker || '', 50) || undefined, source: 'managed', totalAsset: input.totalAsset ?? null, cash: null, monitoringEnabled: true, positions: [], updatedAt: timestamp }
  await atomicWrite(targetPath(), { ...state, accounts: [...state.accounts, account], updatedAt: timestamp })
  return account
})

export const updateHouseholdMember = async (id: string, patch: Partial<Pick<HouseholdMember, 'name' | 'relationship' | 'riskProfile' | 'monitoringEnabled'>>): Promise<HouseholdMember> => mutate(async () => {
  const state = await loadStored()
  const current = state.members.find((member) => member.id === id)
  if (!current) throw new Error('家庭成员不存在')
  const member = { ...current, ...patch, name: patch.name === undefined ? current.name : clean(patch.name), relationship: patch.relationship === undefined ? current.relationship : clean(patch.relationship, 20), updatedAt: now() }
  if (!member.name) throw new Error('成员姓名不能为空')
  await atomicWrite(targetPath(), { ...state, members: state.members.map((item) => item.id === id ? member : item), updatedAt: member.updatedAt })
  return member
})

export const updateHouseholdAccount = async (id: string, patch: Partial<Pick<HouseholdAccount, 'name' | 'broker' | 'totalAsset' | 'monitoringEnabled'>>): Promise<HouseholdAccount> => mutate(async () => {
  const state = await loadStored()
  const current = state.accounts.find((account) => account.id === id)
  if (!current) throw new Error('账户不存在')
  if (patch.totalAsset != null && (!Number.isFinite(patch.totalAsset) || patch.totalAsset < 0)) throw new Error('总资产不能小于 0')
  const account = { ...current, ...patch, name: patch.name === undefined ? current.name : clean(patch.name), broker: patch.broker === undefined ? current.broker : clean(patch.broker, 50) || undefined, updatedAt: now() }
  if (!account.name) throw new Error('账户名称不能为空')
  await atomicWrite(targetPath(), { ...state, accounts: state.accounts.map((item) => item.id === id ? account : item), updatedAt: account.updatedAt })
  return account
})

export const recordManagedHouseholdTrade = async (accountId: string, trade: TradeRecordInput, instrument: Instrument): Promise<void> => mutate(async () => {
  if (!Number.isInteger(trade.quantity) || trade.quantity <= 0) throw new Error('成交数量必须是正整数')
  if (!Number.isFinite(trade.price) || trade.price <= 0) throw new Error('成交价格必须大于 0')
  const state = await loadStored()
  const account = state.accounts.find((item) => item.id === accountId)
  if (!account || account.source !== 'managed') throw new Error('家庭账户不存在或不可写入')
  const positions = [...account.positions]
  const index = positions.findIndex((position) => position.instrument.code === trade.code)
  const current = index >= 0 ? positions[index] : null
  if (trade.side === 'sell' && (!current || current.quantity < trade.quantity)) throw new Error(`卖出数量超过确认持仓，当前最多 ${current?.quantity || 0}`)
  const oldQuantity = current?.quantity || 0
  const quantity = trade.side === 'buy' ? oldQuantity + trade.quantity : oldQuantity - trade.quantity
  const averageCost = trade.side === 'buy' ? ((current?.averageCost || 0) * oldQuantity + trade.price * trade.quantity + (trade.fee || 0)) / quantity : current?.averageCost ?? null
  const next: HouseholdPosition = { instrument, quantity, availableQuantity: trade.side === 'buy' ? current?.availableQuantity || 0 : Math.max(0, (current?.availableQuantity || 0) - trade.quantity), averageCost, status: quantity === 0 ? 'closed' : 'confirmed' }
  if (index >= 0) positions[index] = next
  else positions.push(next)
  const timestamp = trade.occurredAt || now()
  const event = { id: randomUUID(), accountId, instrument, side: trade.side, quantity: trade.quantity, price: trade.price, fee: trade.fee ?? null, occurredAt: timestamp, note: trade.note || null, source: 'user_confirmed_via_jiucai_box' }
  const gross = trade.price * trade.quantity
  const cash = account.cash == null ? null : account.cash + (trade.side === 'buy' ? -gross : gross) - (trade.fee || 0)
  const updated: StoredAccount = { ...account, cash, totalAsset: account.totalAsset == null ? null : account.totalAsset - (trade.fee || 0), positions, events: [...(account.events || []), event], updatedAt: timestamp }
  await atomicWrite(targetPath(), { ...state, accounts: state.accounts.map((item) => item.id === accountId ? updated : item), updatedAt: timestamp })
  await atomicWrite(join(home(), 'household/cases', `${timestamp.replace(/[:.]/g, '-')}-${event.id}.json`), event)
})
