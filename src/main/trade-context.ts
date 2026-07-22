import type { TradeMasterSnapshot } from '../shared/types'

export const HOUSEHOLD_PORTFOLIO_WRITE_RULES = {
  capability: '只有本机 Codex 聊天在 fact_home 目录运行时才可以修改本地交易 JSON；OpenAI compatible/API 模式只能说明需要用户到“家庭持仓 → 记一笔成交”录入，不能声称已经写入。',
  fact_home_rule: '所有真实交易文件都在 fact_home；不要使用 /Users/bytedance/trade-master，也不要猜测仓库目录。当前工作目录通常就是 fact_home。',
  source_of_truth: {
    primary_owner_account: '本人主账户只读展示来自 portfolio.json。页面要求每条 positions[] 都包含 instrument.code、instrument.name、instrument.type、instrument.exchange；顶层 code/name 会被页面忽略。',
    managed_household_accounts: '家人或托管账户来自 household/portfolio.json，账户 source 必须是 managed 才能直接写入该账户持仓；source=primary 与 portfolio.json 是同一主账户，不要重复计算。',
    ignored_for_portfolio_page: 'transactions.json 和 daily-account-state.json 不能单独驱动家庭持仓页面；不要只改这两个文件来声称持仓已更新。'
  },
  primary_position_shape: {
    file: 'portfolio.json',
    required_position_fields: {
      instrument: { code: '6位证券代码', name: '证券名称', type: 'stock|etf|cbond', exchange: 'SH|SZ|BJ' },
      quantity: '当前确认持仓数量，数字',
      available_quantity: '当前可用数量，数字；T+1 买入当天通常为 0，已有券商截图则按截图',
      average_cost: '成本价，未知用 null',
      status: 'confirmed|pending|closed'
    },
    audit: '确认成交写入 historical_order_events[]；不要把已清仓记录当当前持仓。'
  },
  household_file_shape: {
    file: 'household/portfolio.json',
    root: { version: 1, members: 'HouseholdMember[]', accounts: 'HouseholdAccount[]', updatedAt: 'ISO 时间' },
    account_fields: {
      id: '稳定账户 id',
      memberId: '必须匹配 members[].id',
      name: '账户名',
      source: 'managed',
      totalAsset: '数字或 null',
      cash: '数字或 null',
      monitoringEnabled: 'boolean',
      positions: 'HouseholdPosition[]',
      updatedAt: 'ISO 时间'
    },
    position_fields: {
      instrument: { code: '6位证券代码', name: '证券名称', type: 'stock|etf|cbond', exchange: 'SH|SZ|BJ' },
      quantity: '当前确认持仓数量，数字',
      availableQuantity: '当前可用数量，数字',
      averageCost: '成本价，未知用 null',
      status: 'confirmed|pending|closed'
    }
  },
  safe_write_protocol: [
    '只有用户明确要求“录入、更新、修正、加入家庭持仓/成交”，且已给出成员/账户、证券代码或名称、买卖方向、数量、成交价/成本这些关键字段时才写入；缺字段先追问。',
    '改写前先读取现有 JSON，保留未知字段和无关账户，不合并不同成员或账户。',
    '卖出时不得超过该账户确认持仓；买入时更新数量和平均成本；状态为 quantity=0 时写 closed，否则 confirmed。',
    '写完必须用 JSON 解析或测试命令验证文件有效，再重新读取确认页面所需字段存在。',
    '最终回复必须列出实际修改的文件、成员、账户、证券、数量和成本；如果没有写入，必须明确说没有改动。'
  ]
} as const

const positionFacts = (portfolio: unknown) => {
  const value = portfolio as { cash?: unknown; cash_status?: unknown; cash_confirmed_at?: unknown; frozen_cash?: unknown; frozen_cash_status?: unknown; frozen_cash_confirmed_at?: unknown; active_orders_status?: unknown; active_orders_confirmed_at?: unknown; total_asset?: unknown; total_asset_estimate_before_unconfirmed_fees?: unknown; positions?: Array<Record<string, unknown>>; pending_events?: unknown[]; conflicts?: unknown[] } | null
  if (!value) return null
  return {
    cash: value.cash,
    cash_status: value.cash_status,
    cash_confirmed_at: value.cash_confirmed_at,
    frozen_cash: value.frozen_cash,
    frozen_cash_status: value.frozen_cash_status,
    frozen_cash_confirmed_at: value.frozen_cash_confirmed_at,
    active_orders_status: value.active_orders_status,
    active_orders_confirmed_at: value.active_orders_confirmed_at,
    total_asset: value.total_asset ?? value.total_asset_estimate_before_unconfirmed_fees,
    positions: (value.positions || []).map((position) => ({
      instrument: position.instrument,
      quantity: position.quantity,
      available_quantity: position.available_quantity,
      average_cost: position.average_cost,
      status: position.status,
      restrictions: position.restrictions
    })),
    pending_events: value.pending_events || [],
    conflicts: value.conflicts || []
  }
}

export const buildTradeContext = (snapshot: TradeMasterSnapshot): string => JSON.stringify({
  as_of: snapshot.loadedAt,
  fact_home: snapshot.home,
  user_profile: snapshot.userProfile,
  household_write_rules: HOUSEHOLD_PORTFOLIO_WRITE_RULES,
  portfolio: positionFacts(snapshot.portfolio),
  daily_account_state: snapshot.accountState ? {
    trading_date: snapshot.accountState.tradingDate,
    account_id: snapshot.accountState.accountId,
    available_cash: snapshot.accountState.availableCash,
    frozen_cash: snapshot.accountState.frozenCash,
    active_orders: snapshot.accountState.activeOrders,
    rule: '同一交易日内已确认字段直接复用；只询问缺失字段，不得把已确认字段重新标为待确认。'
  } : null,
  household_portfolios: snapshot.household ? {
    members: snapshot.household.members.map((member) => ({ id: member.id, name: member.name, relationship: member.relationship, risk_profile: member.riskProfile, monitoring_enabled: member.monitoringEnabled })),
    accounts: snapshot.household.accounts.map((account) => ({ id: account.id, member_id: account.memberId, name: account.name, broker: account.broker, source: account.source, total_asset: account.totalAsset, cash: account.cash, monitoring_enabled: account.monitoringEnabled, positions: account.positions }))
  } : null,
  watchlist: snapshot.watchlist,
  goals: snapshot.goals,
  discipline: snapshot.discipline,
  strategy_profile: snapshot.strategyProfile,
  active_strategies: snapshot.strategies,
  strategy_candidates: snapshot.strategyCandidates,
  evolution: snapshot.evolution,
  off_market_voc: snapshot.voc ? {
    sources: snapshot.voc.sources.map((source) => ({ id: source.id, platform: source.platform, name: source.displayName, inverse_weight: source.inverseWeight, status: source.status })),
    recent_reports: snapshot.voc.recentReports.slice(0, 8),
    rule: '场外 VOC 只作为反向情绪风险因子，不能单独触发买卖；必须与行情、资金、账户和交易纪律交叉验证。'
  } : null,
  data_errors: snapshot.errors
})
