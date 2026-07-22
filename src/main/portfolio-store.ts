import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Instrument, TradeRecordInput } from '../shared/types'

interface RawPosition {
  instrument?: Instrument
  quantity: number
  available_quantity: number
  average_cost: number | null
  status: string
  sources?: Array<Record<string, unknown>>
  [key: string]: unknown
}

interface PortfolioFile {
  schema_version?: number
  as_of?: string
  cash?: number | null
  total_asset?: number | null
  cash_estimate_before_unconfirmed_fees?: number | null
  total_asset_estimate_before_unconfirmed_fees?: number | null
  estimate_status?: string
  positions?: RawPosition[]
  pending_events?: unknown[]
  conflicts?: unknown[]
  historical_order_events?: Array<Record<string, unknown>>
  [key: string]: unknown
}

const factHome = () => process.env.TRADE_MASTER_HOME || join(homedir(), '.trade-master')

const atomicWrite = async (target: string, value: unknown) => {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(`${target}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(`${target}.tmp`, target)
}

export const recordConfirmedTrade = async (trade: TradeRecordInput, instrument: Instrument): Promise<void> => {
  if (!Number.isInteger(trade.quantity) || trade.quantity <= 0) throw new Error('成交数量必须是正整数')
  if (!Number.isFinite(trade.price) || trade.price <= 0) throw new Error('成交价格必须大于 0')
  if (trade.fee != null && (!Number.isFinite(trade.fee) || trade.fee < 0)) throw new Error('手续费不能小于 0')
  const target = join(factHome(), 'portfolio.json')
  let portfolio: PortfolioFile = { schema_version: 1, positions: [], pending_events: [], conflicts: [], historical_order_events: [] }
  try { portfolio = JSON.parse(await readFile(target, 'utf8')) as PortfolioFile }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const positions = (portfolio.positions || []).map((position) => {
    if (position.instrument?.code && position.instrument.name) return position
    const code = String(position.code || '').trim()
    const name = String(position.name || '').trim()
    if (!/^\d{6}$/.test(code) || !name) return position
    const type: Instrument['type'] = position.instrument_type === 'etf' || position.instrumentType === 'etf'
      ? 'etf'
      : position.instrument_type === 'cbond' || position.instrumentType === 'cbond' ? 'cbond' : 'stock'
    const exchange: Instrument['exchange'] = position.exchange === 'SZ' || position.exchange === 'BJ' ? position.exchange : 'SH'
    return {
      ...position,
      instrument: { code, name, type, exchange },
      available_quantity: Number(position.available_quantity ?? position.availableQuantity ?? 0),
      average_cost: typeof position.average_cost === 'number'
        ? position.average_cost
        : Number(position.cost_price ?? position.costPrice ?? position.cost) || null,
      status: position.status === 'closed' ? 'closed' : position.status === 'pending' ? 'pending' : 'confirmed'
    }
  })
  const index = positions.findIndex((position) => position.instrument?.code === trade.code)
  const current = index >= 0 ? positions[index] : null
  if (trade.side === 'sell' && (!current || current.quantity < trade.quantity)) throw new Error(`卖出数量超过确认持仓，当前最多 ${current?.quantity || 0}`)

  const occurredAt = trade.occurredAt || new Date().toISOString()
  const eventId = `app-${trade.side}-${trade.code}-${randomUUID()}`
  const oldQuantity = current?.quantity || 0
  const nextQuantity = trade.side === 'buy' ? oldQuantity + trade.quantity : oldQuantity - trade.quantity
  const averageCost = trade.side === 'buy'
    ? ((current?.average_cost || 0) * oldQuantity + trade.price * trade.quantity + (trade.fee || 0)) / nextQuantity
    : current?.average_cost ?? null
  const available = trade.side === 'buy'
    ? current?.available_quantity || 0
    : Math.max(0, (current?.available_quantity || 0) - trade.quantity)
  const source = { event_id: eventId, source: 'user_confirmed_via_jiucai_box', occurred_at: occurredAt, note: trade.note || '用户在韭菜盒子确认成交' }
  const nextPosition: RawPosition = {
    ...(current || {}), instrument, quantity: nextQuantity, available_quantity: available,
    available_quantity_status: trade.side === 'buy' ? 'pending_broker_reconciliation' : 'derived_from_confirmed_sale',
    average_cost: averageCost, status: nextQuantity === 0 ? 'closed' : 'confirmed',
    sources: [...(current?.sources || []), source]
  }
  if (index >= 0) positions[index] = nextPosition
  else positions.push(nextPosition)

  const gross = trade.price * trade.quantity
  const direction = trade.side === 'buy' ? -1 : 1
  const cashBase = portfolio.cash ?? portfolio.cash_estimate_before_unconfirmed_fees
  const assetBase = portfolio.total_asset ?? portfolio.total_asset_estimate_before_unconfirmed_fees
  const cashEstimate = cashBase == null ? null : cashBase + direction * gross - (trade.fee || 0)
  const assetEstimate = assetBase == null ? null : assetBase - (trade.fee || 0)
  const exact = trade.fee != null && portfolio.cash != null && portfolio.total_asset != null
  const event = {
    event_id: eventId, status: 'filled_user_confirmed', instrument, side: trade.side, quantity: trade.quantity,
    price: trade.price, gross_amount: gross, fee: trade.fee ?? null,
    fee_status: trade.fee == null ? 'pending_broker_confirmation' : 'user_confirmed', occurred_at: occurredAt,
    source: 'jiucai_box_user_confirmation', note: trade.note || null
  }
  const nextPortfolio: PortfolioFile = {
    ...portfolio,
    schema_version: 1,
    as_of: occurredAt,
    cash: exact ? cashEstimate : null,
    total_asset: exact ? assetEstimate : null,
    cash_estimate_before_unconfirmed_fees: cashEstimate,
    total_asset_estimate_before_unconfirmed_fees: assetEstimate,
    estimate_status: exact ? 'confirmed_trade_and_fee_applied' : 'confirmed_trade_fee_or_broker_cash_pending',
    positions,
    historical_order_events: [...(portfolio.historical_order_events || []), event]
  }
  await atomicWrite(target, nextPortfolio)
  await atomicWrite(join(factHome(), 'cases', 'app-trades', `${eventId}.json`), event)
}
