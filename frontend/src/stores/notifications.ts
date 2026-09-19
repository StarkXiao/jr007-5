import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
import type { NotificationItem, NotificationLevel, Paged } from "@/api/types";

const POLL_INTERVAL_MS = 60_000;

export const useNotificationStore = defineStore("notifications", () => {
  const items = ref<NotificationItem[]>([]);
  const unread = ref(0);
  const loading = ref(false);
  const levelFilter = ref<NotificationLevel | "">("");

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let swListener: ((event: MessageEvent) => void) | null = null;

  const hasUnread = computed(() => unread.value > 0);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const result = await api.get<Paged<NotificationItem> & { unread: number }>(
        "/notifications",
        {
          pageSize: 30,
          ...(levelFilter.value ? { level: levelFilter.value } : {}),
        },
      );
      items.value = result.items;
      unread.value = result.unread;
    } finally {
      loading.value = false;
    }
  }

  /** 只刷新未读角标，轻量轮询用——通知中心打开时才需要完整列表 */
  async function refreshUnread(): Promise<void> {
    try {
      const result = await api.get<Paged<NotificationItem> & { unread: number }>(
        "/notifications",
        { pageSize: 1 },
      );
      unread.value = result.unread;
    } catch {
      // 角标刷新失败保持沉默，下个周期会再试
    }
  }

  async function markAllRead(): Promise<void> {
    const result = await api.post<{ marked: number; unread: number }>("/notifications/read", {});
    unread.value = result.unread;
    items.value = items.value.map((item) => ({ ...item, read: true }));
  }

  async function markRead(ids: string[]): Promise<void> {
    const result = await api.post<{ marked: number; unread: number }>(
      "/notifications/read",
      { ids },
    );
    unread.value = result.unread;
    items.value = items.value.map((item) =>
      ids.includes(String(item.id)) ? { ...item, read: true } : item,
    );
  }

  /**
   * 登录后开始后台同步：
   * - 每分钟轮询一次未读数（兼容所有浏览器，不依赖推送权限）；
   * - 若用户启用了浏览器推送，SW 收到消息时立即刷新，不必等下一个轮询周期。
   */
  function startAutoSync(): void {
    stopAutoSync();
    void refreshUnread();
    pollTimer = setInterval(() => void refreshUnread(), POLL_INTERVAL_MS);

    if ("serviceWorker" in navigator) {
      swListener = (event: MessageEvent) => {
        if (event.data?.type === "psdm:push-received") void refreshUnread();
      };
      navigator.serviceWorker.addEventListener("message", swListener);
    }
  }

  function stopAutoSync(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (swListener && "serviceWorker" in navigator) {
      navigator.serviceWorker.removeEventListener("message", swListener);
    }
    swListener = null;
  }

  function reset(): void {
    stopAutoSync();
    items.value = [];
    unread.value = 0;
    levelFilter.value = "";
  }

  return {
    items,
    unread,
    loading,
    levelFilter,
    hasUnread,
    load,
    refreshUnread,
    markAllRead,
    markRead,
    startAutoSync,
    stopAutoSync,
    reset,
  };
});
