<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import { useNotificationStore } from "@/stores/notifications";

const auth = useAuthStore();
const catalog = useCatalogStore();
const notifications = useNotificationStore();
const route = useRoute();
const router = useRouter();

const isMapPage = computed(() => route.name === "map");

let pollTimer: number | undefined;

// 后台标签页也会收到站内信：每 60 秒同步一次未读数，
// 浏览器推送点击后回到页面时（visibilitychange）再立即刷新
function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (auth.isLoggedIn && document.visibilityState === "visible") {
      void notifications.syncUnread();
    }
  }, 60_000);
}

function stopPolling() {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

// 登录/退出发生在 App 挂载之后（例如登录页跳转）时同步轮询状态
watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (loggedIn) {
      void notifications.load().catch(() => undefined);
      startPolling();
    } else {
      stopPolling();
    }
  },
);

function onVisible() {
  if (document.visibilityState === "visible" && auth.isLoggedIn) {
    void notifications.syncUnread();
  }
}

// 点击系统通知后 sw.js 聚焦本标签页并发来目标地址（可能是绝对 URL，需归一化为站内路径）
function onSwMessage(event: MessageEvent<{ type?: string; url?: string }>) {
  if (event.data?.type !== "NOTIFICATION_NAVIGATE" || !event.data.url) return;
  let target = event.data.url;
  try {
    const parsed = new URL(target, window.location.origin);
    if (parsed.origin === window.location.origin) target = parsed.pathname + parsed.search + parsed.hash;
  } catch {
    // 已经是相对路径时直接使用
  }
  if (target.startsWith("/")) void router.push(target);
}

onMounted(async () => {
  await catalog.load().catch(() => undefined);

  if (auth.isLoggedIn) {
    await notifications.load().catch(() => undefined);
    startPolling();
  }

  document.addEventListener("visibilitychange", onVisible);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onSwMessage);
  }
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener("visibilitychange", onVisible);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.removeEventListener("message", onSwMessage);
  }
});

async function handleLogout() {
  await auth.logout();
  stopPolling();
  notifications.reset();
  ElMessage.success("已退出登录");
  router.push({ name: "map" });
}

async function goNotifications() {
  await router.push({ name: "notifications" });
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink to="/" class="app-brand">
        <span class="app-brand__dot" />
        公共空间细节地图
      </RouterLink>

      <nav class="app-nav">
        <RouterLink to="/">地图</RouterLink>
        <template v-if="auth.isLoggedIn">
          <RouterLink to="/me">我的记录</RouterLink>
        </template>
        <template v-if="auth.isModerator">
          <RouterLink to="/review">审核台</RouterLink>
          <RouterLink to="/reports">举报处置</RouterLink>
        </template>
        <template v-if="auth.isAdmin">
          <RouterLink to="/admin">管理后台</RouterLink>
        </template>
      </nav>

      <div class="app-actions">
        <template v-if="auth.isLoggedIn">
          <el-badge :value="notifications.unread" :hidden="!notifications.hasUnread" :max="99">
            <el-button text circle aria-label="通知" @click="goNotifications">
              <el-icon><Bell /></el-icon>
            </el-button>
          </el-badge>

          <el-dropdown>
            <span class="app-user">
              {{ auth.user?.nickname }}
              <el-tag v-if="auth.isMuted" size="small" type="warning">禁言中</el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="router.push('/me')">我的记录</el-dropdown-item>
                <el-dropdown-item @click="router.push('/me/notifications')">通知中心</el-dropdown-item>
                <el-dropdown-item divided @click="handleLogout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>

        <template v-else>
          <el-button text @click="router.push({ name: 'login' })">登录</el-button>
          <el-button type="primary" @click="router.push({ name: 'register' })">注册</el-button>
        </template>
      </div>
    </header>

    <main class="app-main" :class="{ 'app-main--flush': isMapPage }">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-user {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 14px;
  color: var(--color-text);
  outline: none;
}

.app-main--flush {
  overflow: hidden;
}
</style>
