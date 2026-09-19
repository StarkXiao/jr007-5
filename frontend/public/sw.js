/*
 * 公共空间细节地图 - 浏览器推送 Service Worker
 *
 * 这个文件由 Vite 原样拷贝到站点根目录（/sw.js），不能走打包：
 * 浏览器要求 SW 脚本与作用域同源且可直接访问，且更新检查依赖独立的 URL。
 *
 * 改完这个文件后：浏览器会在下次进入页面时自动安装新版本，
 * 但要等所有旧标签关闭后才会激活（skipWaiting + clients.claim 已开启，可立即生效）。
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const LEVEL_TAG = {
  critical: "紧急",
  important: "重要",
  normal: "",
  info: "",
};

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "你有一条新通知", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "你有一条新通知";
  const levelTag = LEVEL_TAG[data.level] ? `[${LEVEL_TAG[data.level]}] ` : "";

  const options = {
    body: data.body || "",
    tag: data.notificationId ? `psdm-${data.notificationId}` : "psdm-default",
    // 同名 tag 的新通知会替换旧的，避免同一事件刷屏
    renotify: false,
    requireInteraction: data.level === "critical",
    data: { url: data.url || "/me/notifications" },
  };

  event.waitUntil(
    self.registration.showNotification(`${levelTag}${title}`, options).then(() =>
      notifyOpenClients(),
    ),
  );
});

/** 通知到达时，让所有已打开的站点标签刷新未读数 */
async function notifyOpenClients() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "psdm:push-received" });
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetPath = event.notification.data?.url || "/me/notifications";
  // scope 形如 https://host/（开发环境是 http://localhost:5173/）
  const targetUrl = new URL(targetPath, self.registration.scope).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // 已有打开的标签：聚焦并跳转，不重复开页
        for (const client of clients) {
          if ("focus" in client) {
            client.postMessage({ type: "psdm:navigate", url: targetPath });
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
