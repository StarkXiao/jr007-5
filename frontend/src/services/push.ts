import { api } from "@/api/client";

/**
 * 浏览器推送（Notification API + Push API + VAPID）。
 *
 * 只支持 https 或 localhost——这是浏览器的硬要求；
 * 不支持/未授权时调用方应当只让开关静默不可用，不能因此报错。
 */

export interface PushAvailability {
  supported: boolean;
  /** 后端是否配置了 VAPID（未配置时无法生成订阅） */
  configured: boolean;
  vapidPublicKey: string;
}

export async function getPushAvailability(): Promise<PushAvailability> {
  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  try {
    const result = await api.get<{
      subscribed: boolean;
      configured: boolean;
      vapidPublicKey: string;
    }>("/me/push-subscription");
    return {
      supported,
      configured: result.configured,
      vapidPublicKey: result.vapidPublicKey,
    };
  } catch {
    return { supported, configured: false, vapidPublicKey: "" };
  }
}

/** VAPID 公钥的 base64url -> Uint8Array（Push API 订阅时必须传字节数组） */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * 开启浏览器推送：
 * 1. 请求系统通知权限；
 * 2. 注册站点根作用域的 service worker；
 * 3. 向浏览器推送服务订阅，把订阅信息交给后端。
 */
export async function enablePush(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("当前浏览器不支持系统通知推送");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("系统通知权限被拒绝，请在浏览器站点设置中允许通知");
  }

  const meta = await api.get<{
    push: { configured: boolean; vapidPublicKey: string };
  }>("/me/settings");
  if (!meta.push?.configured || !meta.push.vapidPublicKey) {
    throw new Error("服务端尚未配置推送密钥（VAPID）");
  }

  // scope 必须是根路径，才能让通知点击打开站内任意页面
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(meta.push.vapidPublicKey),
    }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("浏览器返回的订阅信息不完整");
  }

  await api.post("/me/push-subscription", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** 关闭推送：退订浏览器订阅并通知后端删除记录 */
export async function disablePush(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // 浏览器侧清理失败不影响后端关闭开关
  }
  await api.del("/me/push-subscription").catch(() => undefined);
}
