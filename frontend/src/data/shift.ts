/**
 * 班次归属的唯一判定口径：列表、班次详情、核对与导出都只能走这一份，
 * 不允许各处再按「补水时间」「记录时间」分别判断。
 *
 * 交班时点（三班制，整点交班归新班）：
 *   08:00 白班接夜班；16:00 中班接白班；00:00 夜班接中班。
 *   [00:00, 08:00) 夜班——跨零点，统一归属交班开始日（前一个自然日）；
 *   [08:00, 16:00) 白班；[16:00, 24:00) 中班。
 * 判定基准时间统一取「记录时间」（班次报送时间），与补水发生时间解耦。
 */

export type ShiftName = '白班' | '中班' | '夜班'

// 展示与排序都按交班顺序：白班 -> 中班 -> 夜班（跨零点的夜班排在当日最后）。
export const SHIFT_ORDER: ShiftName[] = ['白班', '中班', '夜班']

export type ShiftInfo = {
  name: ShiftName
  /** 归属日期（YYYY-MM-DD）：夜班取交班开始日，即前一个自然日。 */
  date: string
  /** 列表、详情、导出统一展示的班次标签。 */
  label: string
  /** 去重键：同一换热站、同一归属日、同一班次只认第一次报送。 */
  key: string
}

const TIME_PATTERN =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/

/** 解析「YYYY-MM-DD[ HH:mm[:ss]]」形式的时间；只有日期时按 00:00 处理。 */
export function parseShiftTime(raw: unknown): Date | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const text = String(raw).trim()
  if (!text) {
    return null
  }
  const matched = text.match(TIME_PATTERN)
  if (!matched) {
    return null
  }
  const [, year, month, day, hour, minute, second] = matched
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour ? Number(hour) : 0,
    minute ? Number(minute) : 0,
    second ? Number(second) : 0,
  )
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 当前时间戳，落库为「YYYY-MM-DD HH:mm:ss」，保证再次解析仍走同一口径。 */
export function currentStamp(): string {
  const now = new Date()
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':')
  return `${formatDate(now)} ${time}`
}

/**
 * 按交班时点判定班次归属。无法解析的时间返回 null，由调用方决定拒绝还是兼容。
 */
export function resolveShift(recordTime: unknown): ShiftInfo | null {
  const date = parseShiftTime(recordTime)
  if (!date) {
    return null
  }
  const minutes = date.getHours() * 60 + date.getMinutes()
  let name: ShiftName
  let belongDate = formatDate(date)

  if (minutes < 8 * 60) {
    // 00:00–08:00 为夜班，跨零点，归属交班开始日（前一个自然日）。
    name = '夜班'
    const start = new Date(date)
    start.setDate(start.getDate() - 1)
    belongDate = formatDate(start)
  } else if (minutes < 16 * 60) {
    // 08:00 整点交班归白班。
    name = '白班'
  } else {
    // 16:00 整点交班归中班；24:00 整点进入次日零点，按次日 00:00 归前日夜班。
    name = '中班'
  }

  return { name, date: belongDate, label: `${belongDate} ${name}`, key: `${belongDate}|${name}` }
}
