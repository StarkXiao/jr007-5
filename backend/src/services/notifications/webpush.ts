import webpush from "web-push";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

export interface PushPayload {
  title: string;
  body: string;
  /** 点击通知后前端跳转的站内相对路径 */
  url?: string;
  data?: Record<string, unknown>;
}

let configured = false;

export function isPushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export function getVapidPublicKey(): string {
  return env.VAPID_PUBLIC_KEY;
}

function ensureConfigured(): void {
  if (configured || !isPushConfigured()) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
}

export type PushResult = "sent" | "failed" | "gone" | "skipped";

/**
 * 浏览器推送同样是"尽力而为"通道。
 * - gone（404/410）：订阅已失效，调用方应删除该订阅；
 * - failed：网络或推送服务临时错误，保留订阅下次重试。
 */
export async function sendPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<PushResult> {
  if (!isPushConfigured()) {
    logger.info({ endpoint: subscription.endpoint.slice(0, 48) }, "[push:disabled] 未配置 VAPID，跳过浏览器推送");
    return "skipped";
  }

  ensureConfigured();

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify({ ...payload, icon: "/icon-192.png", badge: "/icon-192.png" }),
      { TTL: 86400 },
    );
    return "sent";
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      logger.info({ statusCode, endpoint: subscription.endpoint.slice(0, 48) }, "浏览器推送订阅已失效");
      return "gone";
    }
    logger.warn(
      { err: (error as Error).message, statusCode },
      "浏览器推送发送失败",
    );
    return "failed";
  }
}
