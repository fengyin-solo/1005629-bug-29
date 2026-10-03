/**
 * 补水定压的班次归属领域逻辑。
 *
 * 口径只有一份：resolveShift（见 shift.ts），判定基准为「记录时间」。
 * 列表、班次详情、核对动作、CSV 导出都从 buildMakeupSnapshot 取同一份快照，
 * 不再存在两处各算一套、跨天记录归到不同班次的情况。
 *
 * 历史兼容：记录上冻结了班次（班次归属字段）的，一律沿用当时归属，
 * 尤其是已经核对过的记录，详情与列表都读冻结值，不再按新口径重算。
 */

import { listRows, saveRows } from './local-store'
import { currentStamp, parseShiftTime, resolveShift, SHIFT_ORDER, type ShiftInfo } from './shift'
import type { ActionResult, EntryRow } from './types'

export const MAKEUP_KEY = 'makeupwater'
export const PATROL_KEY = 'stationpatrol'

// 落库字段：历史记录没有这些键时按缺省兼容，不强制迁移。
export const RECORD_TIME_FIELD = '记录时间'
export const SHIFT_FIELD = '班次归属'
export const SHIFT_DATE_FIELD = '班次日期'
export const SUBMITTED_AT_FIELD = '首次报送时间'
export const VERIFIED_AT_FIELD = '核对时间'
export const DEDUP_KEY_FIELD = '去重键'
export const DUPLICATE_FIELD = '重复报送'

export type MakeupRow = EntryRow & {
  [RECORD_TIME_FIELD]?: string
  [SHIFT_FIELD]?: string
  [SHIFT_DATE_FIELD]?: string
  [SUBMITTED_AT_FIELD]?: string
  [VERIFIED_AT_FIELD]?: string
  [DEDUP_KEY_FIELD]?: string
  [DUPLICATE_FIELD]?: string
}

export type MakeupSnapshotRow = MakeupRow & {
  shift: ShiftInfo | null
  /** 是否为本班次的第一次报送（重复报送为 false，所有统计只计第一条）。 */
  primary: boolean
}

export type ShiftGroup = {
  key: string
  date: string
  shiftName: string
  label: string
  total: number
  /** 第一次报送的有效记录条数（重复报送只算一次）。 */
  primaryCount: number
  pendingCount: number
  verifiedCount: number
  abnormalCount: number
  duplicateCount: number
}

export type MakeupSnapshot = {
  rows: MakeupSnapshotRow[]
  groups: ShiftGroup[]
  stats: {
    pending: number
    verified: number
    abnormal: number
    duplicate: number
  }
}

const PENDING_STATUS = '待记录'
const VERIFIED_STATUS = '已核对'
const ABNORMAL_STATUS = '参数异常'

function asText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

/** 补水量必须有可识别的非零数值，缺失或非数字一律不予受理。 */
export function hasValidAmount(row: EntryRow): boolean {
  const amount = Number.parseFloat(asText(row['补水量']))
  return Number.isFinite(amount) && amount > 0
}

function frozenShift(row: MakeupRow): ShiftInfo | null {
  const name = asText(row[SHIFT_FIELD])
  const date = asText(row[SHIFT_DATE_FIELD])
  if (!name || !date || !SHIFT_ORDER.includes(name as ShiftInfo['name'])) {
    return null
  }
  return {
    name: name as ShiftInfo['name'],
    date,
    label: `${date} ${name}`,
    key: `${date}|${name}`,
  }
}

/**
 * 单条记录的班次归属：已冻结的沿用冻结值（历史核对结果不动）；
 * 否则按交班时点统一口径重算。基准时间优先「记录时间」，
 * 没有记录时间的老数据回落到「补水时间」，并在提交时补齐记录时间。
 */
export function rowShift(row: MakeupRow): ShiftInfo | null {
  const frozen = frozenShift(row)
  if (frozen) {
    return frozen
  }
  return resolveShift(row[RECORD_TIME_FIELD]) ?? resolveShift(row['补水时间']) ?? null
}

function orderTime(row: MakeupRow): number {
  return (
    parseShiftTime(row[SUBMITTED_AT_FIELD])?.getTime() ??
    parseShiftTime(row[RECORD_TIME_FIELD])?.getTime() ??
    Number(row.id)
  )
}

/**
 * 生成全模块唯一一份快照：归属、重复报送标记、班次分组、统计都在这里算一次，
 * 列表 / 详情 / 核对 / 导出 / 巡检联动共用。
 */
export function buildMakeupSnapshot(
  rows: MakeupRow[] = listRows(MAKEUP_KEY) as MakeupRow[],
): MakeupSnapshot {
  const enriched: MakeupSnapshotRow[] = rows.map((row) => ({
    ...row,
    shift: rowShift(row),
    primary: true,
  }))

  // 重复报送按第一次认：同换热站、同班次归属，首次报送时间最早（回退用 id）的为有效记录。
  // 待记录的草稿不参与去重，只有真正报送（已记录及之后状态）才认班。
  const winnerByGroup = new Map<string, number>()
  const candidates = enriched
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status !== PENDING_STATUS && row.shift !== null)
    .sort((a, z) => orderTime(a.row) - orderTime(z.row) || Number(a.row.id) - Number(z.row.id))
  for (const { row, index } of candidates) {
    const groupKey = `${asText(row['换热站'])}|${row.shift?.key ?? ''}`
    if (!winnerByGroup.has(groupKey)) {
      winnerByGroup.set(groupKey, index)
    }
  }
  for (const { row, index } of candidates) {
    const groupKey = `${asText(row['换热站'])}|${row.shift?.key ?? ''}`
    enriched[index].primary = winnerByGroup.get(groupKey) === index
  }

  const groupMap = new Map<string, ShiftGroup>()
  for (const row of enriched) {
    if (!row.shift) {
      continue
    }
    const groupKey = `${row.shift.date}|${row.shift.name}`
    let group = groupMap.get(groupKey)
    if (!group) {
      group = {
        key: groupKey,
        date: row.shift.date,
        shiftName: row.shift.name,
        label: row.shift.label,
        total: 0,
        primaryCount: 0,
        pendingCount: 0,
        verifiedCount: 0,
        abnormalCount: 0,
        duplicateCount: 0,
      }
      groupMap.set(groupKey, group)
    }
    group.total += 1
    if (!row.primary) {
      group.duplicateCount += 1
      continue
    }
    group.primaryCount += 1
    if (row.status === PENDING_STATUS) {
      group.pendingCount += 1
    }
    if (row.status === VERIFIED_STATUS) {
      group.verifiedCount += 1
    }
    if (row.status === ABNORMAL_STATUS) {
      group.abnormalCount += 1
    }
  }

  const groups = [...groupMap.values()].sort((a, b) => {
    if (a.date !== b.date) {
      return a.date < b.date ? -1 : 1
    }
    return (
      SHIFT_ORDER.indexOf(a.shiftName as ShiftInfo['name']) -
      SHIFT_ORDER.indexOf(b.shiftName as ShiftInfo['name'])
    )
  })

  const primaryRows = enriched.filter((row) => row.primary)
  return {
    rows: enriched,
    groups,
    stats: {
      pending: primaryRows.filter((row) => row.status === PENDING_STATUS).length,
      verified: primaryRows.filter((row) => row.status === VERIFIED_STATUS).length,
      abnormal: primaryRows.filter((row) => row.status === ABNORMAL_STATUS).length,
      duplicate: enriched.filter((row) => !row.primary).length,
    },
  }
}

function freezeShift(row: MakeupRow, shift: ShiftInfo): MakeupRow {
  return {
    ...row,
    [SHIFT_FIELD]: shift.name,
    [SHIFT_DATE_FIELD]: shift.date,
    [DEDUP_KEY_FIELD]: `${asText(row['换热站'])}|${shift.key}`,
  }
}

// ── 巡检待核查清单联动 ────────────────────────────────────────────
// 补水定压核对出「参数异常」后，站点巡检那边生成/保留一条待核查项；
// 重新核对正常后撤回仍处于「待核查」的联动项（已处理的不动）。

const PATROL_SOURCE_FIELD = '问题来源'
const PATROL_REF_FIELD = '来源记录'
const PATROL_WAIT_FIELD = '待核查'
const PATROL_WAIT_STATUS = '待核查'

function upsertPatrolIssue(sourceRow: MakeupRow): void {
  const rows = listRows(PATROL_KEY)
  const refId = String(sourceRow.id)
  const existing = rows.find(
    (row) =>
      asText(row[PATROL_SOURCE_FIELD]) === MAKEUP_KEY &&
      asText(row[PATROL_REF_FIELD]) === refId,
  )
  if (existing) {
    const index = rows.indexOf(existing)
    rows[index] = { ...existing, [PATROL_WAIT_FIELD]: '是', pending: true }
    saveRows(PATROL_KEY, rows)
    return
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const issue: EntryRow = {
    id: nextId,
    status: PATROL_WAIT_STATUS,
    pending: true,
    abnormal: false,
    巡检编号: `CHK-${String(nextId).padStart(4, '0')}`,
    巡检站点: asText(sourceRow['换热站']) || '未登记换热站',
    巡检路线: '补水参数异常复核',
    巡检人: '待派单',
    巡检日期: currentStamp().slice(0, 10),
    发现问题数: 1,
    整改期限: '',
    巡检状态: PATROL_WAIT_STATUS,
    [PATROL_SOURCE_FIELD]: MAKEUP_KEY,
    [PATROL_REF_FIELD]: refId,
    [PATROL_WAIT_FIELD]: '是',
  }
  saveRows(PATROL_KEY, [...rows, issue])
}

function clearPatrolIssue(sourceId: number): void {
  const rows = listRows(PATROL_KEY)
  let changed = false
  const next = rows.filter((row) => {
    const linked =
      asText(row[PATROL_SOURCE_FIELD]) === MAKEUP_KEY &&
      asText(row[PATROL_REF_FIELD]) === String(sourceId)
    if (!linked) {
      return true
    }
    // 已经被巡检侧处理过的联动项保留痕迹，只撤回仍在「待核查」的。
    if (asText(row[PATROL_WAIT_FIELD]) === '是' && row.status === PATROL_WAIT_STATUS) {
      changed = true
      return false
    }
    return true
  })
  if (changed) {
    saveRows(PATROL_KEY, next)
  }
}

/** 巡检侧读取的待核查清单：同样来自补水定压那份快照，状态口径不会两边跑偏。 */
export function listPatrolChecklist(): EntryRow[] {
  return listRows(PATROL_KEY).filter(
    (row) =>
      asText(row[PATROL_SOURCE_FIELD]) === MAKEUP_KEY &&
      asText(row[PATROL_WAIT_FIELD]) === '是',
  )
}

// ── 动作：提交记录 / 确认核对 / 标记异常 ───────────────────────────

export function runMakeupAction(id: number, action: string): ActionResult {
  const rows = listRows(MAKEUP_KEY) as MakeupRow[]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的补水定压记录` }
  }
  const current = rows[index]

  if (action === '提交记录') {
    if (current.status !== PENDING_STATUS) {
      return { ok: false, message: `补水定压记录已经报送（当前「${current.status}」），不能重复提交` }
    }
    // 补水量缺失的不予受理：列表中保留但不能报送、不进班次统计。
    if (!hasValidAmount(current)) {
      return { ok: false, message: '补水量缺失或不是有效数值，该记录不予受理，请补全补水量后再报送' }
    }
    // 记录时间缺失的老数据，能从补水时间识别就沿用，否则以实际提交时刻补齐；归属都按它算。
    const recordTime =
      asText(current[RECORD_TIME_FIELD]) ||
      (resolveShift(current['补水时间']) ? asText(current['补水时间']) : '') ||
      currentStamp()
    const shift = resolveShift(recordTime)
    if (!shift) {
      return { ok: false, message: '记录时间无法识别，不能判定班次，请补全记录时间后再报送' }
    }
    const duplicateOf = buildMakeupSnapshot(rows).rows.find(
      (row) =>
        row.primary &&
        row.status !== PENDING_STATUS &&
        asText(row['换热站']) === asText(current['换热站']) &&
        row.shift?.key === shift.key,
    )
    if (duplicateOf) {
      // 重复的班次报送不受理为新班次记录：按第一次报送认，保留第一条。
      return {
        ok: false,
        message: `该换热站「${shift.label}」已由记录 ${duplicateOf['记录编号'] ?? duplicateOf.id} 报送，班次报送按第一次认，请勿重复提交`,
      }
    }
    rows[index] = freezeShift(
      {
        ...current,
        status: '已记录',
        pending: true,
        [RECORD_TIME_FIELD]: recordTime,
        [SUBMITTED_AT_FIELD]: asText(current[SUBMITTED_AT_FIELD]) || currentStamp(),
        [DUPLICATE_FIELD]: '',
      },
      shift,
    )
    saveRows(MAKEUP_KEY, rows)
    return { ok: true, message: `记录已报送，班次归属「${shift.label}」` }
  }

  if (action === '确认核对') {
    if (current.status === VERIFIED_STATUS) {
      return { ok: false, message: '该记录已经核对过，无需重复核对' }
    }
    if (!hasValidAmount(current)) {
      return { ok: false, message: '补水量缺失的记录不予核对，请先补全补水量并完成报送' }
    }
    let shift = rowShift(current)
    if (!shift) {
      return { ok: false, message: '记录时间无法识别，不能判定班次，无法核对' }
    }
    // 已报送但未冻结班次的历史数据，核对时按统一口径冻结，之后列表与详情都读它。
    let updated: MakeupRow = freezeShift({ ...current }, shift)
    shift = rowShift(updated) ?? shift
    updated = {
      ...updated,
      status: VERIFIED_STATUS,
      pending: false,
      abnormal: false,
      [VERIFIED_AT_FIELD]: currentStamp(),
    }
    rows[index] = updated
    saveRows(MAKEUP_KEY, rows)
    // 核对正常：撤回仍待核查的巡检联动项。
    clearPatrolIssue(Number(current.id))
    return { ok: true, message: `记录已核对，班次归属按交班时点锁定为「${shift.label}」` }
  }

  if (action === '标记异常') {
    if (current.status === ABNORMAL_STATUS) {
      return { ok: false, message: '该记录已标记为参数异常' }
    }
    let shift = rowShift(current)
    let updated: MakeupRow = { ...current, status: ABNORMAL_STATUS, pending: false, abnormal: true }
    if (shift) {
      updated = freezeShift(updated, shift)
      shift = rowShift(updated) ?? shift
    }
    rows[index] = updated
    saveRows(MAKEUP_KEY, rows)
    // 核对结果驱动巡检侧的待核查清单。
    upsertPatrolIssue(updated)
    return {
      ok: true,
      message: shift
        ? `已标记参数异常（班次「${shift.label}」），并同步到站点巡检待核查清单`
        : '已标记参数异常，并同步到站点巡检待核查清单',
    }
  }

  return { ok: false, message: `补水定压记录没有登记「${action}」这个动作` }
}
