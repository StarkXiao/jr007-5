import { prisma, toJsonValue } from "../../db/prisma";
import {
  DEFAULT_CHANNEL_MIN_LEVEL,
  NOTIFICATION_LEVEL_BY_TYPE,
  type NotificationLevel,
} from "../../config/constants";
import type { NotificationDeliveryStatus } from "@prisma/client";
import { logger } from "../../utils/logger";
import { sendMail } from "../mailer";
import { sendPush } from "../push";
import { enqueueNotifyJob } from "../queue";
import { levelAtLeast, planNotification } from "./policy";
import type { NotifyInput } from "./types";

const LEVELS: readonly NotificationLevel[] = ["critical", "important", "normal", "info"];

function normalizeLevel(value: string | null | undefined): NotificationLevel {
  return (LEVELS.find((item) => item === value) ?? "normal");
}

interface ResolvedSettings {
  notifyEmail: boolean;
  notifyPush: boolean;
  emailMinLevel: NotificationLevel;
  pushMinLevel: NotificationLevel;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timeZone: string;
}

/**
 * 统一触达入口：站内信、邮件、浏览器推送三条通道在这里分级分流。
 *
 * 站内信永远入库（审计与对账凭证）；
 * 邮件/推送是尽力而为的外部通道，按级别阈值与静默时段决策后：
 *   - 立即发送 -> status=pending 入队列，由 worker 投递并回写 sent/failed；
 *   - 静默暂缓 -> status=deferred + deferred_until，巡检到点后以摘要补发；
 *   - 不满足条件 -> status=skipped。
 * 通知失败不影响主流程。
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    const level: NotificationLevel =
      input.level ?? NOTIFICATION_LEVEL_BY_TYPE[input.type] ?? "normal";

    const settings = await loadSettings(input.userId);
    const plan = planNotification({ level, settings });

    const notification = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        level,
        title: input.title.slice(0, 80),
        body: input.body?.slice(0, 300) ?? null,
        payload: toJsonValue(input.payload ?? {}),
        inappStatus: "sent",
        emailStatus: decisionToStatus(plan.channels.email.action),
        pushStatus: decisionToStatus(plan.channels.push.action),
        deferredUntil: plan.deferredUntil,
      },
    });

    logger.debug(
      {
        notificationId: notification.id.toString(),
        userId: input.userId.toString(),
        level,
        email: plan.channels.email.action,
        push: plan.channels.push.action,
      },
      "通知已分级分流",
    );

    if (plan.channels.email.action === "sent" || plan.channels.push.action === "sent") {
      const enqueued = await enqueueNotifyJob({ notificationId: notification.id.toString() });
      if (!enqueued) {
        // 队列不可用时降级为同步投递，避免外部通道停在 pending
        await deliverNotification(notification.id.toString()).catch((error) => {
          logger.warn({ err: (error as Error).message }, "同步投递通知失败");
        });
      }
    }
  } catch (error) {
    logger.error(
      { err: (error as Error).message, userId: input.userId.toString(), type: input.type },
      "通知创建失败",
    );
  }
}

function decisionToStatus(action: "sent" | "deferred" | "skipped"): NotificationDeliveryStatus {
  if (action === "sent") return "pending";
  if (action === "deferred") return "deferred";
  return "skipped";
}

async function loadSettings(userId: bigint): Promise<ResolvedSettings> {
  const row = await prisma.userSetting.findUnique({ where: { userId } });

  return {
    notifyEmail: row?.notifyEmail ?? true,
    notifyPush: row?.notifyPush ?? false,
    emailMinLevel: normalizeLevel(row?.emailMinLevel) ?? DEFAULT_CHANNEL_MIN_LEVEL.email,
    pushMinLevel: normalizeLevel(row?.pushMinLevel) ?? DEFAULT_CHANNEL_MIN_LEVEL.push,
    quietHoursEnabled: row?.quietHoursEnabled ?? false,
    quietHoursStart: row?.quietHoursStart ?? "22:00",
    quietHoursEnd: row?.quietHoursEnd ?? "08:00",
    timeZone: row?.timeZone ?? "Asia/Shanghai",
  };
}

// ------------------------------------------------------------------ 即时投递

const NOTIFICATION_PAGE_PATH = "/me/notifications";

/**
 * 投递单条通知的邮件 / 浏览器推送（状态必须为 pending）。
 * 由 worker 消费；队列不可用时 API 进程也会同步调用。
 */
export async function deliverNotification(
  notificationId: string,
): Promise<{ email: NotificationDeliveryStatus; push: NotificationDeliveryStatus }> {
  const id = BigInt(notificationId);
  const notification = await prisma.notification.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          email: true,
          settings: { select: { notifyEmail: true, notifyPush: true } },
        },
      },
    },
  });

  if (!notification) {
    logger.warn({ notificationId }, "通知不存在，跳过投递");
    return { email: "skipped", push: "skipped" };
  }

  const results: { email: NotificationDeliveryStatus; push: NotificationDeliveryStatus } = {
    email: notification.emailStatus,
    push: notification.pushStatus,
  };

  if (notification.emailStatus === "pending") {
    results.email = await deliverEmail(
      { id: notification.id, level: notification.level, title: notification.title, body: notification.body },
      notification.user.email,
    );
  }

  if (notification.pushStatus === "pending") {
    results.push = await deliverPush(
      {
        id: notification.id,
        level: notification.level,
        type: notification.type,
        title: notification.title,
        body: notification.body,
      },
      notification.userId,
      Boolean(notification.user.settings?.notifyPush),
    );
  }

  await prisma.notification.update({
    where: { id },
    data: {
      emailStatus: results.email,
      pushStatus: results.push,
      // 进入终态后清掉暂缓标记
      deferredUntil:
        results.email === "deferred" || results.push === "deferred"
          ? notification.deferredUntil
          : null,
    },
  });

  return results;
}

interface EmailMessageData {
  id: bigint;
  level: string;
  title: string;
  body: string | null;
}

async function deliverEmail(
  data: EmailMessageData,
  email: string | null,
): Promise<NotificationDeliveryStatus> {
  if (!email) return "skipped";

  const subjectPrefix = data.level === "critical" ? "[紧急] " : "";
  const sent = await sendMail({
    to: email,
    subject: `${subjectPrefix}[公共空间细节地图] ${data.title}`,
    text: buildEmailText(data.title, data.body),
  });

  return sent ? "sent" : "failed";
}

function buildEmailText(title: string, body: string | null): string {
  const lines = [title, "", body ?? "", "", "查看全部通知：", NOTIFICATION_PAGE_PATH].filter(
    (line, index, arr) => !(line === "" && arr[index - 1] === ""),
  );
  return lines.join("\n");
}

interface PushMessageData {
  id: bigint;
  level: string;
  type: string;
  title: string;
  body: string | null;
}

async function deliverPush(
  data: PushMessageData,
  userId: bigint,
  pushEnabled: boolean,
): Promise<NotificationDeliveryStatus> {
  if (!pushEnabled) return "skipped";

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId, expired: false },
  });
  if (subscriptions.length === 0) return "skipped";

  const outcomes = await Promise.all(
    subscriptions.map(async (subscription) => {
      const result = await sendPush(
        {
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
        {
          title: data.title,
          body: data.body ?? "",
          url: NOTIFICATION_PAGE_PATH,
          notificationId: data.id.toString(),
          level: data.level,
          type: data.type,
        },
      );

      if (result === "expired") {
        await prisma.pushSubscription
          .update({ where: { id: subscription.id }, data: { expired: true } })
          .catch(() => undefined);
      }
      return result;
    }),
  );

  await prisma.pushSubscription
    .updateMany({
      where: { id: { in: subscriptions.map((item) => item.id) } },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => undefined);

  if (outcomes.includes("sent")) return "sent";
  // 全部订阅失效（或未配置 VAPID）：没有可用通道，按 skipped 收尾，不触发重试
  if (outcomes.every((item) => item === "expired" || item === "skipped")) return "skipped";
  return "failed";
}

// ------------------------------------------------------------------ 静默后补发

/**
 * 静默时段结束后的补发巡检（每 N 分钟一次）。
 *
 * 邮件天然适合聚合：同一用户多条暂缓通知合并成一封"你有 N 条新通知"摘要，
 * 避免静默结束瞬间连刷 N 封邮件。
 * 浏览器推送则每条单独补发——系统通知中心本就按条目展示，聚合反而丢失信息。
 */
export async function flushDeferredNotifications(now: Date = new Date()): Promise<{
  emails: number;
  pushes: number;
  users: number;
}> {
  const due = await prisma.notification.findMany({
    where: {
      OR: [{ emailStatus: "deferred" }, { pushStatus: "deferred" }],
      deferredUntil: { lte: now },
    },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });

  if (due.length === 0) return { emails: 0, pushes: 0, users: 0 };

  const byUser = new Map<bigint, typeof due>();
  for (const notification of due) {
    const list = byUser.get(notification.userId) ?? [];
    list.push(notification);
    byUser.set(notification.userId, list);
  }

  let emails = 0;
  let pushes = 0;

  for (const [userId, notifications] of byUser) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        settings: {
          select: {
            notifyEmail: true,
            notifyPush: true,
            emailMinLevel: true,
            pushMinLevel: true,
            timeZone: true,
          },
        },
      },
    });

    // 账号注销等情况下用户已不存在（外键级联会同时删通知，走到这里属于竞态），直接跳过
    if (!user) continue;

    // 通知创建时已做过缺省补齐，这里理论上 settings 一定存在；缺行时按系统默认值
    const settings = user.settings ?? {
      notifyEmail: true,
      notifyPush: false,
      emailMinLevel: DEFAULT_CHANNEL_MIN_LEVEL.email,
      pushMinLevel: DEFAULT_CHANNEL_MIN_LEVEL.push,
      timeZone: "Asia/Shanghai",
    };

    const emailItems = notifications.filter(
      (item) =>
        item.emailStatus === "deferred" &&
        settings.notifyEmail !== false &&
        !!user.email &&
        levelAtLeast(normalizeLevel(item.level), normalizeLevel(settings.emailMinLevel)),
    );
    const pushItems = notifications.filter(
      (item) =>
        item.pushStatus === "deferred" &&
        settings.notifyPush === true &&
        levelAtLeast(normalizeLevel(item.level), normalizeLevel(settings.pushMinLevel)),
    );

    if (emailItems.length > 0) {
      const sent = await sendDigestEmail(
        user.email!,
        emailItems,
        settings.timeZone,
      );
      await prisma.notification.updateMany({
        where: { id: { in: emailItems.map((item) => item.id) } },
        data: { emailStatus: sent ? "sent" : "failed", deferredUntil: null },
      });
      if (sent) emails += emailItems.length;
    }

    if (pushItems.length > 0) {
      const okCount = await deliverDeferredPushes(userId, pushItems);
      pushes += okCount;
    }

    logger.info(
      { userId: userId.toString(), emails: emailItems.length, pushes: pushItems.length },
      "静默时段结束，补发暂缓通知",
    );
  }

  return { emails, pushes, users: byUser.size };
}

async function sendDigestEmail(
  email: string,
  items: Array<{ title: string; body: string | null; level: string; createdAt: Date }>,
  timeZone: string,
): Promise<boolean> {
  const hasCritical = items.some((item) => item.level === "critical");
  const subject = `[公共空间细节地图] 你有 ${items.length} 条新通知`;

  const lines = items.map((item, index) => {
    const prefix = item.level === "critical" ? "[紧急] " : "";
    const time = item.createdAt.toLocaleString("zh-CN", { timeZone });
    return `${index + 1}. ${prefix}${item.title}（${time}）\n${item.body ?? ""}`;
  });

  const text = [
    hasCritical ? "其中包含紧急通知，请尽快查看。" : "以下通知在你设置的静默时段内到达，现在统一提醒：",
    "",
    ...lines,
    "",
    `查看全部通知：${NOTIFICATION_PAGE_PATH}`,
  ].join("\n");

  return sendMail({ to: email, subject, text });
}

/** 暂缓的浏览器推送逐条补发；已失效订阅由 deliverPush 内部标记 */
async function deliverDeferredPushes(
  userId: bigint,
  items: Array<{
    id: bigint;
    level: string;
    type: string;
    title: string;
    body: string | null;
  }>,
): Promise<number> {
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId, expired: false },
  });

  if (subscriptions.length === 0) {
    await prisma.notification.updateMany({
      where: { id: { in: items.map((item) => item.id) } },
      data: { pushStatus: "skipped", deferredUntil: null },
    });
    return 0;
  }

  let okCount = 0;
  for (const item of items) {
    const outcomes = await Promise.all(
      subscriptions.map(async (subscription) => {
        const result = await sendPush(
          {
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
          {
            title: item.title,
            body: item.body ?? "",
            url: NOTIFICATION_PAGE_PATH,
            notificationId: item.id.toString(),
            level: item.level,
            type: item.type,
          },
        );
        if (result === "expired") return { subscription, expired: true as const };
        return { subscription, expired: false as const, result };
      }),
    );

    const expiredIds = outcomes
      .filter((entry) => entry.expired)
      .map((entry) => entry.subscription.id);
    if (expiredIds.length > 0) {
      await prisma.pushSubscription
        .updateMany({ where: { id: { in: expiredIds } }, data: { expired: true } })
        .catch(() => undefined);
    }

    const statuses = outcomes.map((entry) =>
      entry.expired ? "expired" : entry.result!,
    );
    const status: NotificationDeliveryStatus = statuses.includes("sent")
      ? "sent"
      : statuses.every((outcome) => outcome === "expired" || outcome === "skipped")
        ? "skipped"
        : "failed";

    await prisma.notification.update({
      where: { id: item.id },
      data: { pushStatus: status, deferredUntil: null },
    });

    if (status === "sent") okCount += 1;
  }

  return okCount;
}
