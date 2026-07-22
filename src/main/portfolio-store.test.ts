import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordConfirmedTrade } from './portfolio-store'

const previousHome = process.env.TRADE_MASTER_HOME
afterEach(() => { if (previousHome == null) delete process.env.TRADE_MASTER_HOME; else process.env.TRADE_MASTER_HOME = previousHome })

describe('recordConfirmedTrade', () => {
  it('writes confirmed buys and prevents overselling', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jiucai-portfolio-'))
    process.env.TRADE_MASTER_HOME = home
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'portfolio.json'), JSON.stringify({ cash: 10000, total_asset: 10000, positions: [], historical_order_events: [] }))
    const instrument = { code: '510300', name: '沪深300ETF', type: 'etf' as const, exchange: 'SH' as const }
    await recordConfirmedTrade({ code: '510300', side: 'buy', quantity: 100, price: 3.5, fee: 1 }, instrument)
    const saved = JSON.parse(await readFile(join(home, 'portfolio.json'), 'utf8')) as { cash: number; positions: Array<{ quantity: number; average_cost: number }> }
    expect(saved.cash).toBe(9649)
    expect(saved.positions[0]).toMatchObject({ quantity: 100, average_cost: 3.51 })
    await expect(recordConfirmedTrade({ code: '510300', side: 'sell', quantity: 101, price: 3.6 }, instrument)).rejects.toThrow('卖出数量超过确认持仓')
  })

  it('repairs legacy AI positions before recording another trade', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jiucai-portfolio-'))
    process.env.TRADE_MASTER_HOME = home
    await writeFile(join(home, 'portfolio.json'), JSON.stringify({
      positions: [{ code: '002074', name: '国轩高科', exchange: 'SZ', instrument_type: 'stock', quantity: 200, availableQuantity: 200, cost_price: 27.535 }]
    }))
    const instrument = { code: '002074', name: '国轩高科', type: 'stock' as const, exchange: 'SZ' as const }
    await recordConfirmedTrade({ code: '002074', side: 'buy', quantity: 1, price: 28.02 }, instrument)
    const saved = JSON.parse(await readFile(join(home, 'portfolio.json'), 'utf8')) as { positions: Array<{ instrument: typeof instrument; quantity: number; available_quantity: number; average_cost: number }> }
    expect(saved.positions).toHaveLength(1)
    expect(saved.positions[0]).toMatchObject({ instrument, quantity: 201, available_quantity: 200 })
    expect(saved.positions[0].average_cost).toBeCloseTo((27.535 * 200 + 28.02) / 201)
  })
})
