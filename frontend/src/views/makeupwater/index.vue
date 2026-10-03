<template>
  <section class="page" data-module="makeupwater">
    <header class="page-head">
      <div>
        <h2>补水定压管理</h2>
        <p class="page-desc">班次归属统一按交班时点（08:00 / 16:00 / 24:00）判定，列表、班次详情、核对与导出共用同一份口径；夜班 00:00–08:00 归属交班开始日，重复报送按第一次认。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记补水定压记录</button>
        <button class="btn" type="button" @click="exportRows">导出补水定压清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statsCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">重复报送（只算第一次）：{{ snapshot.stats.duplicate }}</span>
    </p>

    <section class="shift-detail">
      <h3>班次详情（与列表同一份数据，按交班时点归属）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>归属日期</th>
            <th>班次</th>
            <th>记录总数</th>
            <th>有效报送</th>
            <th>待记录</th>
            <th>已核对</th>
            <th>参数异常</th>
            <th>重复报送</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="group in snapshot.groups" :key="group.key">
            <td>{{ group.date }}</td>
            <td>{{ group.shiftName }}</td>
            <td>{{ group.total }}</td>
            <td>{{ group.primaryCount }}</td>
            <td>{{ group.pendingCount }}</td>
            <td>{{ group.verifiedCount }}</td>
            <td>{{ group.abnormalCount }}</td>
            <td>{{ group.duplicateCount }}</td>
          </tr>
          <tr v-if="!snapshot.groups.length">
            <td colspan="8" class="empty-state">暂无可归属班次的记录</td>
          </tr>
        </tbody>
      </table>
      <p class="shift-note">跨零点提示：每日 00:00–08:00 的报送统一归前一日夜班，08:00、16:00 整点交班归新班；历史已核对记录按核对当时冻结的班次保留。</p>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'dup-row': row['重复报送'] === '是' }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '班次归属'">
              <span>{{ row[column] || '未判定' }}</span>
              <em v-if="row['重复报送'] === '是'" class="dup-tag">重复报送</em>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无补水定压数据，可先登记补水定压记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条补水定压记录（重复报送 {{ snapshot.stats.duplicate }} 条，统计只计第一次报送）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  makeupSnapshot,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { MakeupSnapshot } from '@/data/makeup-water'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('makeupwater')
// 列与模块字段同源，班次归属由统一快照给出，列表和导出永远一致。
const columns = meta.fields
const actions = ["提交记录", "确认核对", "标记异常"]
const statuses = ["待记录", "已记录", "已核对", "参数异常"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["记录编号", "换热站", "班次归属"]

const snapshot = ref<MakeupSnapshot>(makeupSnapshot())
const statsCards = computed(() => [
  { label: "待记录班次", value: snapshot.value.stats.pending },
  { label: "已核对记录", value: snapshot.value.stats.verified },
  { label: "参数异常次数", value: snapshot.value.stats.abnormal },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: snapshot.value.rows
      .filter((row) => row.primary && String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '补水定压记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    // 即使被拒绝（重复报送、补水量缺失）也要刷新快照，保证标记与列表一致。
    refreshSnapshot()
    return
  }
  reload()
}

function refreshSnapshot() {
  snapshot.value = makeupSnapshot()
}

function reload() {
  errorMessage.value = ''
  try {
    // 快照先刷新，列表行上的班次归属随它走，详情、统计、导出读到的是同一份。
    refreshSnapshot()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '补水定压列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.shift-detail {
  margin: 12px 0 16px;
}

.shift-detail h3 {
  margin: 0 0 8px;
  font-size: 15px;
}

.shift-note {
  margin: 6px 0 0;
  color: #8a6d3b;
  font-size: 12px;
}

.dup-row {
  color: #999;
}

.dup-tag {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: #fdf1f0;
  color: #c0392b;
  font-size: 12px;
  font-style: normal;
}
</style>
