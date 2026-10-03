import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  buildMakeupSnapshot,
  DUPLICATE_FIELD,
  listPatrolChecklist,
  MAKEUP_KEY,
  runMakeupAction,
  SHIFT_FIELD,
  type MakeupSnapshotRow,
} from '@/data/makeup-water'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

const BOM = '\uFEFF'

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

/**
 * 列表读取：补水定压走班次领域的唯一快照（与详情、核对、导出同源），
 * 行上的「班次归属」「记录时间」均由那份快照算出，列表与班次详情不会再各算一套。
 */
export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === MAKEUP_KEY) {
    const snapshotRows = buildMakeupSnapshot().rows.map((row) => presentMakeupRow(row))
    const matched = filterRows(snapshotRows, filters)
    return { items: matched, total: matched.length, page: 1, size: matched.length }
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function presentMakeupRow(row: MakeupSnapshotRow): EntryRow {
  return {
    ...row,
    [SHIFT_FIELD]: row.shift?.label ?? '',
    [DUPLICATE_FIELD]: row.primary ? '' : '是',
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 补水定压的三个动作都涉及班次口径，统一交给领域模块处理，通用流转不在这里分叉。
  if (key === MAKEUP_KEY) {
    return runMakeupAction(id, action)
  }
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
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 导出：补水定压与列表取同一份快照，班次列按交班时点的统一口径输出；
 * 重复报送只标注，不计入任何次数统计。
 */
export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === MAKEUP_KEY) {
    const header = ['编号', ...meta.fields, '当前状态']
    const lines = [header.join(',')]
    for (const row of buildMakeupSnapshot().rows) {
      const presented = presentMakeupRow(row)
      lines.push(
        [row.id, ...meta.fields.map((field) => presented[field] ?? ''), row.status]
          .map(csvCell)
          .join(','),
      )
    }
    return { filename: `${meta.name}-清单.csv`, content: `${BOM}${lines.join('\n')}` }
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `${BOM}${lines.join('\n')}` }
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

/** 站点巡检页面读取的「补水参数异常待核查清单」，由补水核对结果驱动。 */
export function patrolChecklist(): PageResult {
  const items = listPatrolChecklist()
  return { items, total: items.length, page: 1, size: items.length }
}

/** 补水定压页面的班次详情与统计：和列表、导出取同一份快照。 */
export function makeupSnapshot() {
  return buildMakeupSnapshot()
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
