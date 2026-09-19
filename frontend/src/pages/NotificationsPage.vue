<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useNotificationStore } from "@/stores/notifications";
import type { NotificationLevel } from "@/api/types";

const notifications = useNotificationStore();
const router = useRouter();

const LEVEL_META: Record<NotificationLevel, { label: string; type: "danger" | "info" | "warning" }> = {
  high: { label: "重要", type: "danger" },
  normal: { label: "普通", type: "info" },
  low: { label: "提醒", type: "warning" },
};

// 通知点击后跳到对应位置：审核结果去条目页，要求修改去编辑页
function open(item: (typeof notifications.items)[number]) {
  const spotUuid = item.payload?.spotUuid as string | undefined;
  if (!spotUuid) {
    if (item.type === "notification_digest") {
      // 摘要本身没有具体条目，展开通知列表即可
      return;
    }
    return;
  }

  if (item.type === "review_changes" || item.type === "spot_stale") {
    void router.push({ name: "spot-edit", params: { uuid: spotUuid } });
  } else {
    void router.push({ name: "spot-detail", params: { uuid: spotUuid } });
  }
}

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
            <el-tag size="small" :type="LEVEL_META[item.level as NotificationLevel]?.type ?? 'info'">
              {{ LEVEL_META[item.level as NotificationLevel]?.label ?? "普通" }}
            </el-tag>
            <strong style="margin-left: 8px">{{ item.title }}</strong>
            <el-tag v-if="!item.read" size="small" type="danger" style="margin-left: 8px">未读</el-tag>
            <p style="margin: 6px 0 0; white-space: pre-wrap">{{ item.body }}</p>
            <p v-if="item.channels.email || item.channels.webpush" class="muted" style="margin: 4px 0 0; font-size: 12px">
              已同步：
              <template v-if="item.channels.email">邮件</template>
              <template v-if="item.channels.email && item.channels.webpush">、</template>
              <template v-if="item.channels.webpush">浏览器推送</template>
            </p>
          </div>
          <span class="muted" style="white-space: nowrap">
            {{ new Date(item.createdAt).toLocaleString("zh-CN") }}
          </span>
        </div>
      </el-card>
    </div>
  </div>
</template>
