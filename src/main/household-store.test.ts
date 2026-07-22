import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHouseholdAccount, createHouseholdMember, loadHousehold, PRIMARY_ACCOUNT_ID, recordManagedHouseholdTrade, updateHouseholdAccount } from './household-store'

const previousHome = process.env.TRADE_MASTER_HOME
afterEach(() => { if (previousHome == null) delete process.env.TRADE_MASTER_HOME; else process.env.TRADE_MASTER_HOME = previousHome })

describe('household-store', () => {
  it('hydrates the owner account from the existing primary portfolio', async () => {
    process.env.TRADE_MASTER_HOME = await mkdtemp(join(tmpdir(), 'jiucai-household-primary-'))
    const snapshot = await loadHousehold({ total_asset: 120000, cash: 30000, positions: [{ instrument: { code: '510300', name: '沪深300ETF', type: 'etf', exchange: 'SH' }, quantity: 100, available_quantity: 100, average_cost: 3.8, status: 'confirmed' }] })
    expect(snapshot.members[0]).toMatchObject({ id: 'self', name: '我', isOwner: true })
    expect(snapshot.accounts.find((account) => account.id === PRIMARY_ACCOUNT_ID)).toMatchObject({ totalAsset: 120000, cash: 30000, positions: [{ quantity: 100 }] })
  })

  it('reads legacy AI positions that used top-level instrument fields', async () => {
    process.env.TRADE_MASTER_HOME = await mkdtemp(join(tmpdir(), 'jiucai-household-legacy-'))
    const snapshot = await loadHousehold({ positions: [{ code: '002074', name: '国轩高科', exchange: 'SZ', instrument_type: 'stock', quantity: 200, availableQuantity: 200, cost_price: 27.535 }] })
    expect(snapshot.accounts.find((account) => account.id === PRIMARY_ACCOUNT_ID)?.positions[0]).toMatchObject({
      instrument: { code: '002074', name: '国轩高科', type: 'stock', exchange: 'SZ' },
      quantity: 200,
      availableQuantity: 200,
      averageCost: 27.535
    })
  })

  it('keeps managed family accounts independent and records confirmed trades', async () => {
    process.env.TRADE_MASTER_HOME = await mkdtemp(join(tmpdir(), 'jiucai-household-managed-'))
    const member = await createHouseholdMember({ name: '妈妈', relationship: '母亲', riskProfile: 'conservative' })
    const account = await createHouseholdAccount({ memberId: member.id, name: '妈妈的养老账户', totalAsset: 80000 })
    const instrument = { code: '510300', name: '沪深300ETF', type: 'etf' as const, exchange: 'SH' as const }
    await recordManagedHouseholdTrade(account.id, { code: '510300', side: 'buy', quantity: 200, price: 4, fee: 1 }, instrument)
    await updateHouseholdAccount(account.id, { monitoringEnabled: false })
    const snapshot = await loadHousehold()
    const saved = snapshot.accounts.find((item) => item.id === account.id)
    expect(saved).toMatchObject({ memberId: member.id, totalAsset: 79999, monitoringEnabled: false, positions: [{ quantity: 200, averageCost: 4.005 }] })
    expect(snapshot.accounts.find((item) => item.id === PRIMARY_ACCOUNT_ID)?.positions).toEqual([])
    await expect(recordManagedHouseholdTrade(account.id, { code: '510300', side: 'sell', quantity: 201, price: 4.1 }, instrument)).rejects.toThrow('卖出数量超过确认持仓')
  })
})
