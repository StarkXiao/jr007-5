/*
 * 推送服务工作线程（public/sw.js，由 Vite/Nginx 原样托管在站点根路径）。
 *
 * 只做三件事，刻意不做任何静态资源缓存——地图与接口缓存策略不应被一个推送 SW 牵连：
 * 1. install/activate 后立即接管；
 * 2. 收到 push 事件时显示通知（payload 由后端投递，含 title/body/url）；
 * 3. 用户点击通知时聚焦已有标签页或新开目标页。
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function fallbackPayload() {
  return {
    title: "公共空间细节地图",
    body: "你有一条新通知，点击查看",
    url: "/me/notifications",
  };
}

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : null;
  } catch (_error) {
    data = null;
  }
  const payload = data || fallbackPayload();

  event.waitUntil(
    self.registration.showNotification(payload.title || "公共空间细节地图", {
      body: payload.body || "",
      tag: payload.tag || "psdm-notification",
      icon: payload.icon,
      badge: payload.badge,
      data: { url: payload.url || "/me/notifications" },
      // 静默时段聚合出的摘要保持默认声音；高优先级事件提示更明显
      renotify: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/me/notifications";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // 已经开着就聚焦并跳转，不制造一堆重复标签
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "NOTIFICATION_NAVIGATE", url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
