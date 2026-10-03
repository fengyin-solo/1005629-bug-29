import type { EntryRow } from './types'

// 班次归属的唯一判定处。
// 交班时点：08:00 白班接班、20:00 夜班接班；夜班跨零点，归属按开班日期算。
// 列表、详情、核对、导出都必须从这里取班次，不允许再各自按补水时间/记录时间单算。

export type ShiftName = '白班' | '夜班'

export type ShiftInfo = {
  key: string // 形如 2026-09-01-夜班，可稳定用于分组统计
  name: ShiftName
  date: string // 开班日期，夜班跨零点也归到开班这一天
  label: string // 形如 2026-09-01 夜班 20:00-08:00
}

export const DAY_SHIFT_START = 8
export const NIGHT_SHIFT_START = 20

const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]+(\d{1,2}):(\d{1,2}))?/

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function makeShift(year: number, month: number, day: number, name: ShiftName): ShiftInfo {
  const date = `${year}-${pad2(month)}-${pad2(day)}`
  const range = name === '白班' ? '08:00-20:00' : '20:00-08:00'
  return { key: `${date}-${name}`, name, date, label: `${date} ${name} ${range}` }
}

// 把某个时刻归到唯一班次。边界只认交班时点：08:00 整算白班，20:00 整算夜班，
// 00:00-08:00 算前一日的夜班——跨零点的两班只有这一条规则，各处不得另写。
export function resolveShift(input: string | number | boolean | undefined | null): ShiftInfo | null {
  if (input === undefined || input === null || input === '') {
    return null
  }
  const match = DATE_RE.exec(String(input).trim())
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (match[4] === undefined) {
    // 历史记录只有日期没有时刻，按当日白班归集，和旧列表的按日归类保持一致。
    return makeShift(year, month, day, '白班')
  }
  const hour = Number(match[4])
  if (hour >= DAY_SHIFT_START && hour < NIGHT_SHIFT_START) {
    return makeShift(year, month, day, '白班')
  }
  if (hour >= NIGHT_SHIFT_START) {
    return makeShift(year, month, day, '夜班')
  }
  const prev = new Date(year, month - 1, day - 1)
  return makeShift(prev.getFullYear(), prev.getMonth() + 1, prev.getDate(), '夜班')
}

// 一条补水定压记录的班次：
// 1. 记录上已经定过班次的（核对时锁定或历史遗留）原样保留，不按新规则重算；
// 2. 否则按记录时间归班，老数据没有记录时间的退到补水时间；
// 3. 时间都认不出来的进「未分班」，不硬猜。
export function shiftOfEntry(row: EntryRow): string {
  const stored = String(row['班次'] ?? '').trim()
  if (stored) {
    return stored
  }
  const recordTime = String(row['记录时间'] ?? '').trim()
  const makeupTime = String(row['补水时间'] ?? '').trim()
  const shift = resolveShift(recordTime || makeupTime)
  return shift ? shift.label : '未分班'
}
