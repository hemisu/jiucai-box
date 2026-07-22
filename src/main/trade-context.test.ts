import { describe, expect, it } from 'vitest'
import type { TradeMasterSnapshot } from '../shared/types'
import { buildTradeContext } from './trade-context'

describe('buildTradeContext', () => {
  it('includes confirmed position facts and excludes source-history noise', () => {
    const snapshot: TradeMasterSnapshot = {
      home: '/tmp/facts', userProfile: null, loadedAt: '2026-07-20T16:00:00+08:00', errors: [], watchlist: null, goals: null, discipline: { state: 'CAUTION' }, strategyProfile: null, evolution: null, notifications: null, automation: null, strategies: null, strategyCandidates: [],
      portfolio: { positions: [{ instrument: { code: '159516' }, quantity: 0, status: 'closed', sources: [{ note: 'very long audit entry' }] }], pending_events: [], conflicts: [] }
    }
    const context = buildTradeContext(snapshot)
    expect(context).toContain('159516')
    expect(context).toContain('CAUTION')
    expect(context).not.toContain('very long audit entry')
  })

  it('keeps family members and accounts separated in the AI context', () => {
    const snapshot = {
      home: '/tmp/facts', userProfile: null, loadedAt: '2026-07-20T16:00:00+08:00', errors: [], watchlist: null, goals: null, discipline: { state: 'NORMAL' }, strategyProfile: null, evolution: null, notifications: null, automation: null, strategies: null, strategyCandidates: [], portfolio: null,
      household: {
        members: [{ id: 'mother', name: '妈妈', relationship: '母亲', riskProfile: 'conservative', monitoringEnabled: true, isOwner: false, createdAt: '', updatedAt: '' }],
        accounts: [{ id: 'retirement', memberId: 'mother', name: '养老账户', source: 'managed', totalAsset: 80000, cash: 10000, monitoringEnabled: true, positions: [{ instrument: { code: '510300', name: '沪深300ETF', type: 'etf', exchange: 'SH' }, quantity: 200, availableQuantity: 200, averageCost: 4, status: 'confirmed' }], updatedAt: '' }],
        updatedAt: ''
      }
    } satisfies TradeMasterSnapshot
    const context = buildTradeContext(snapshot)
    expect(context).toContain('household_portfolios')
    expect(context).toContain('养老账户')
    expect(context).toContain('conservative')
  })

  it('teaches the AI the writable household portfolio schema', () => {
    const snapshot: TradeMasterSnapshot = {
      home: '/tmp/facts', userProfile: null, loadedAt: '2026-07-20T16:00:00+08:00', errors: [], watchlist: null, goals: null, discipline: null, strategyProfile: null, evolution: null, notifications: null, automation: null, strategies: null, strategyCandidates: [],
      portfolio: null,
      household: null
    }
    const context = buildTradeContext(snapshot)
    expect(context).toContain('household_write_rules')
    expect(context).toContain('household/portfolio.json')
    expect(context).toContain('transactions.json')
    expect(context).toContain('顶层 code/name 会被页面忽略')
    expect(context).toContain('/Users/bytedance/trade-master')
  })
})
