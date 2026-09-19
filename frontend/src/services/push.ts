import { api } from "@/api/client";
import type { PushVapidKey } from "@/api/types";

/**
 * 浏览器推送封装（Service Worker + Push API + VAPID）。
 *
 * 完整链路：
 * 浏览器权限 → 注册 sw.js → pushManager.subscribe(VAPID 公钥) →
 * 订阅信息回传后端 → 后端经推送服务（FCM/Mozilla/…）触达，sw.js 显示通知。
 *
 * 注意：requestPermission 必须由用户手势（点击开关）触发，不能在页面加载时自动弹。
 */

const SW_PATH = "/sw.js";

function supported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof window !== "undefined"
  );
}

export type PushSupport = "ready" | "unsupported" | "disabled";

export async function pushSupport(): Promise<PushSupport> {
  if (!supported()) return "unsupported";
  if (window.isSecureContext === false) return "unsupported";

  const config = await api.get<PushVapidKey>("/notifications/push/vapid-key");
  return config.enabled && config.publicKey ? "ready" : "disabled";
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (existing) return existing;
  return navigator.serviceWorker.register(SW_PATH);
}

/**
 * 订阅浏览器推送。
 * - denied：用户在浏览器层面拒绝过，代码无法再弹授权框，只能引导用户手动改设置；
 * - 后端未配置 VAPID：抛错让设置页提示"站点未开启推送"。
 */
export async function subscribePush(): Promise<void> {
  if (!supported()) throw new Error("当前浏览器不支持消息推送");

  const config = await api.get<PushVapidKey>("/notifications/push/vapid-key");
  if (!config.enabled || !config.publicKey) {
    throw new Error("站点尚未配置浏览器推送");
  }

  const permission = await Notification.requestPermission();
  if (permission === "denied") {
    throw new Error("浏览器已拒绝通知权限，请在浏览器站点设置中手动开启");
  }
  if (permission !== "granted") throw new Error("未获得通知授权");

  const registration = await getRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  });

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("推送订阅信息不完整");
  }

  await api.post("/notifications/push/subscriptions", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** 关闭推送：本地退订并通知后端删除该 endpoint */
export async function unsubscribePush(): Promise<void> {
  if (!supported()) return;

  const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
  const subscription = await registration?.pushManager.getSubscription();
  const endpoint = subscription?.endpoint;

  if (subscription) await subscription.unsubscribe().catch(() => undefined);
  await api.del("/notifications/push/subscriptions", endpoint ? { endpoint } : undefined);
}

/** 当前浏览器是否已有一条生效的推送订阅 */
export async function hasLocalSubscription(): Promise<boolean> {
  if (!supported()) return false;
  const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
  const subscription = await registration?.pushManager.getSubscription();
  return Boolean(subscription);
}
