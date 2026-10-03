import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { resolveShift, shiftOfEntry } from '@/data/shifts'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(visibleRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 页面、详情、统计与导出共用的一份行数据。
// 补水定压在这里收拢两处口径：重复报送按第一次认（同记录编号只留最早一条），
// 班次统一按交班时点挂上，之后谁读都是同一个值。
function visibleRows(key: string): EntryRow[] {
  const rows = listRows(key)
  if (key !== 'makeupwater') {
    return rows
  }
  const seen = new Set<string>()
  const prepared: EntryRow[] = []
  for (const row of rows) {
    const reportNo = String(row['记录编号'] ?? '').trim()
    const dedupeKey = reportNo || `id:${row.id}`
    if (seen.has(dedupeKey)) {
      continue
    }
    seen.add(dedupeKey)
    prepared.push({ ...row, 班次: shiftOfEntry(row) })
  }
  return prepared
}

// 核对出参数异常时，给站点巡检生成一条待核查任务；同一记录只生成一次。
function syncPatrolCheck(source: EntryRow): boolean {
  const patrolRows = listRows('stationpatrol')
  const reportNo = String(source['记录编号'] ?? `ID-${source.id}`)
  const checkNo = `核查-${reportNo}`
  if (patrolRows.some((row) => String(row['巡检编号']) === checkNo)) {
    return false
  }
  const shift = shiftOfEntry(source)
  const date =
    resolveShift(source['记录时间'] ?? source['补水时间'])?.date ??
    new Date().toISOString().slice(0, 10)
  const nextId = patrolRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const task: EntryRow = {
    id: nextId,
    status: '待巡检',
    pending: true,
    abnormal: false,
    巡检编号: checkNo,
    巡检站点: String(source['换热站'] ?? '—'),
    巡检路线: `补水定压参数异常复核（${reportNo} · ${shift}）`,
    巡检人: '待指派',
    巡检日期: date,
    发现问题数: 1,
    整改期限: date,
    巡检状态: '待核查',
  }
  saveRows('stationpatrol', [...patrolRows, task])
  return true
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (key === 'makeupwater' && action === '提交记录') {
    const amount = String(rows[index]['补水量'] ?? '').trim()
    if (!amount) {
      return { ok: false, message: `${meta.entity}补水量缺失，不予受理` }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === 'makeupwater' && action === '确认核对') {
    // 核对通过时把班次锁定在记录上，之后列表、详情、导出读到的都是这个值。
    updated['班次'] = shiftOfEntry(rows[index])
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  let message = `${meta.entity}已${action}，当前状态「${target}」`
  if (key === 'makeupwater' && target === '参数异常' && syncPatrolCheck(updated)) {
    message += '，已同步站点巡检待核查清单'
  }
  return { ok: true, message }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 导出与列表走同一份行数据：同样的去重、同样的班次，两边数目才对得上。
  for (const row of visibleRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
