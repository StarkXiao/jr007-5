import webpush from "web-push";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

let configured = false;

/**
 * VAPID 密钥对缺失时不抛错：浏览器推送是"尽力而为"的通道，
 * 开发环境/未配置的实例应当只影响推送本身，站内信与邮件照常工作。
 */
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return false;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export function vapidPublicKey(): string {
  return env.VAPID_PUBLIC_KEY;
}

export function isPushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export interface PushPayload {
  title: string;
  body: string;
  /** 点击通知后的站内跳转路径 */
  url?: string;
  /** 通知中心条目 id，用于前端聚合与已读联动 */
  notificationId?: string;
  level?: string;
  type?: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushResult = "sent" | "expired" | "failed" | "skipped";

/**
 * 向单个订阅发送浏览器推送。
 * 404/410 表示订阅已失效（用户清了站点数据或退订），调用方应删除该订阅；
 * 其余错误（推送服务抖动等）只记为 failed，保留订阅等下次再试。
 */
export async function sendPush(target: PushTarget, payload: PushPayload): Promise<PushResult> {
  if (!ensureConfigured()) {
    logger.info({ endpoint: maskEndpoint(target.endpoint) }, "[push:disabled] 未配置 VAPID，跳过浏览器推送");
    return "skipped";
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: target.endpoint,
        keys: { p256dh: target.p256dh, auth: target.auth },
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 12 },
    );
    return "sent";
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      logger.warn({ statusCode, endpoint: maskEndpoint(target.endpoint) }, "浏览器推送订阅已失效");
      return "expired";
    }
    logger.warn(
      { statusCode, err: (error as Error).message, endpoint: maskEndpoint(target.endpoint) },
      "浏览器推送失败",
    );
    return "failed";
  }
}

/** 日志里只保留订阅 host 与末 8 字符，endpoint 本身可用于推送，不整段落盘 */
function maskEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const tail = endpoint.slice(-8);
    return `${url.host}/...${tail}`;
  } catch {
    return "invalid-endpoint";
  }
}
