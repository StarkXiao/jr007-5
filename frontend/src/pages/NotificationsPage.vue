<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useNotificationStore } from "@/stores/notifications";
import type { NotificationLevel } from "@/api/types";

const notifications = useNotificationStore();
const router = useRouter();

const LEVEL_TAG_TYPE: Record<NotificationLevel, "danger" | "warning" | "info" | "info"> = {
  critical: "danger",
  important: "warning",
  normal: "info",
  info: "info",
};

const LEVEL_LABEL: Record<NotificationLevel, string> = {
  critical: "紧急",
  important: "重要",
  normal: "普通",
  info: "提醒",
};

// 通知点击后跳到对应位置：审核结果去条目页，要求修改去编辑页
async function open(item: (typeof notifications.items)[number]) {
  if (!item.read) {
    await notifications.markRead([String(item.id)]);
  }

  const spotUuid = item.payload?.spotUuid as string | undefined;
  if (!spotUuid) {
    return;
  }

  if (item.type === "review_changes" || item.type === "spot_stale") {
    void router.push({ name: "spot-edit", params: { uuid: spotUuid } });
  } else {
    void router.push({ name: "spot-detail", params: { uuid: spotUuid } });
  }
}

watch(
  () => notifications.levelFilter,
  () => void notifications.load(),
);

onMounted(() => void notifications.load());
</script>

<template>
  <div class="page">
    <h1 class="page-title">
      通知
      <el-button size="small" :disabled="!notifications.hasUnread" @click="notifications.markAllRead()">
        全部标为已读
      </el-button>
    </h1>

    <div style="margin-bottom: 12px; display: flex; gap: 8px; align-items: center">
      <span class="muted">级别</span>
      <el-radio-group v-model="notifications.levelFilter" size="small">
        <el-radio-button label="">全部</el-radio-button>
        <el-radio-button label="critical">紧急</el-radio-button>
        <el-radio-button label="important">重要</el-radio-button>
        <el-radio-button label="normal">普通</el-radio-button>
        <el-radio-button label="info">提醒</el-radio-button>
      </el-radio-group>
    </div>

    <div v-loading="notifications.loading">
      <el-empty v-if="notifications.items.length === 0" description="还没有通知" />

      <el-card
        v-for="item in notifications.items"
        :key="item.id"
        shadow="never"
        style="margin-bottom: 10px; cursor: pointer"
        :style="{ opacity: item.read ? 0.72 : 1 }"
        @click="open(item)"
      >
        <div style="display: flex; justify-content: space-between; gap: 10px">
          <div>
            <el-tag :type="LEVEL_TAG_TYPE[item.level as NotificationLevel]" size="small" effect="plain" style="margin-right: 8px">
              {{ LEVEL_LABEL[item.level as NotificationLevel] ?? item.level }}
            </el-tag>
            <strong>{{ item.title }}</strong>
            <el-tag v-if="!item.read" size="small" type="danger" style="margin-left: 8px">未读</el-tag>
            <p style="margin: 6px 0 0; white-space: pre-wrap">{{ item.body }}</p>
          </div>
          <span class="muted" style="white-space: nowrap">
            {{ new Date(item.createdAt).toLocaleString("zh-CN") }}
          </span>
        </div>
      </el-card>
    </div>
  </div>
</template>
