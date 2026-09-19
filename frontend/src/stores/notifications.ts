import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api/client";
import type { NotificationItem, Paged } from "@/api/types";

export const useNotificationStore = defineStore("notifications", () => {
  const items = ref<NotificationItem[]>([]);
  const unread = ref(0);
  const loading = ref(false);

  const hasUnread = computed(() => unread.value > 0);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const result = await api.get<Paged<NotificationItem> & { unread: number }>("/notifications", {
        pageSize: 30,
      });
      items.value = result.items;
      unread.value = result.unread;
    } finally {
      loading.value = false;
    }
  }

  async function markAllRead(): Promise<void> {
    const result = await api.post<{ marked: number; unread: number }>("/notifications/read", {});
    unread.value = result.unread;
    items.value = items.value.map((item) => ({ ...item, read: true }));
  }

  // 后台轮询只同步未读数，避免把通知列表整个刷掉
  async function syncUnread(): Promise<void> {
    const result = await api.get<Paged<NotificationItem> & { unread: number }>(
      "/notifications",
      { unreadOnly: true, pageSize: 1 },
    );
    unread.value = result.unread;
  }

  function reset(): void {
    items.value = [];
    unread.value = 0;
  }

  return { items, unread, loading, hasUnread, load, markAllRead, syncUnread, reset };
});
