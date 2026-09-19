import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { QUEUE_NAMES, QUEUE_PREFIX } from "../../config/constants";
import { createBullConnection } from "../../db/redis";
import { logger } from "../../utils/logger";

export interface ImageJobData {
  assetUuid: string;
  /** 重新渲染时标记，用于审计与日志区分 */
  reason: "upload" | "blur-update" | "retry";
}

export interface SweepJobData {
  task: "sla-sweep" | "stale-sweep" | "purge-originals" | "cleanup" | "flush-deferred";
}

export interface NotifyJobData {
  notificationId: string;
}

const bullConnection: Redis = createBullConnection();

let imageQueue: Queue<ImageJobData> | undefined;
let sweepQueue: Queue<SweepJobData> | undefined;
let notifyQueue: Queue<NotifyJobData> | undefined;

export function getImageQueue(): Queue<ImageJobData> {
  if (!imageQueue) {
    imageQueue = new Queue<ImageJobData>(QUEUE_NAMES.IMAGE, {
      connection: bullConnection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return imageQueue;
}

export function getSweepQueue(): Queue<SweepJobData> {
  if (!sweepQueue) {
    sweepQueue = new Queue<SweepJobData>(QUEUE_NAMES.SLA, {
      connection: bullConnection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return sweepQueue;
}

/**
 * 投递图片处理任务。
 *
 * 返回 false 表示队列不可用（例如 Redis 宕机），调用方应改为同步处理，
 * 否则图片会永远停在 processing 状态——这是众包产品最容易出现的死锁。
 */
export async function enqueueImageJob(data: ImageJobData, timeoutMs = 3000): Promise<boolean> {
  try {
    const queue = getImageQueue();
    await Promise.race([
      queue.add("process-image", data, { jobId: `img:${data.assetUuid}:${Date.now()}` }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("入队超时")), timeoutMs)),
    ]);
    return true;
  } catch (error) {
    logger.warn({ err: (error as Error).message, assetUuid: data.assetUuid }, "图片任务入队失败，将同步处理");
    return false;
  }
}

export function getNotifyQueue(): Queue<NotifyJobData> {
  if (!notifyQueue) {
    notifyQueue = new Queue<NotifyJobData>(QUEUE_NAMES.NOTIFY, {
      connection: bullConnection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        // 外部通道（SMTP / 推送服务）都可能瞬时抖动，给 3 次指数退避重试
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return notifyQueue;
}

/**
 * 投递单条通知的外部通道（邮件 / 浏览器推送）。
 * 和图片任务一样：返回 false 表示队列不可用，调用方应改为同步处理，
 * 不能让 Redis 宕机导致邮件/推送静默丢失。
 */
export async function enqueueNotifyJob(
  data: NotifyJobData,
  timeoutMs = 3000,
): Promise<boolean> {
  try {
    const queue = getNotifyQueue();
    await Promise.race([
      queue.add("deliver-notification", data, {
        jobId: `notify:${data.notificationId}`,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("入队超时")), timeoutMs)),
    ]);
    return true;
  } catch (error) {
    logger.warn(
      { err: (error as Error).message, notificationId: data.notificationId },
      "通知投递任务入队失败，将同步处理",
    );
    return false;
  }
}

export async function closeQueues(): Promise<void> {
  await imageQueue?.close().catch(() => undefined);
  await sweepQueue?.close().catch(() => undefined);
  await notifyQueue?.close().catch(() => undefined);
  await bullConnection.quit().catch(() => undefined);
}

export { QUEUE_NAMES };
