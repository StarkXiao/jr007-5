import { prisma, toJsonValue } from "../db/prisma";
import {
  NOTIFICATION_TYPES,
  type NotificationLevel,
  type NotificationType,
} from "../config/constants";
import { logger } from "../utils/logger";
import { sendMail } from "./mailer";
import { sendPush, isPushConfigured } from "./notifications/webpush";
import {
  levelOf,
  planDelivery,
  type QuietHoursSettings,
} from "./notifications/policy";
import { env } from "../config/env";

export interface NotifyInput {
  userId: bigint;
  type: NotificationType;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  /** 覆盖该类型的默认重要程度（例如 SLA 告警按 high 处理） */
  level?: NotificationLevel;
}

type UserSettingsRow = {
  notifyEmail: boolean;
  notifyInapp: boolean;
  notifyPush: boolean;
  quietHoursEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  timezone: string;
} | null;

const DEFAULT_SETTINGS = {
  notifyEmail: true,
  notifyInapp: true,
  notifyPush: false,
  quietHoursEnabled: false,
  quietStart: 1320,
  quietEnd: 480,
  timezone: "Asia/Shanghai",
};

/**
 * 统一触达入口：站内信、邮件、浏览器推送三条通道在这里分级决策。
 *
 * 通知失败不影响主流程，但要留下日志，避免"用户没收到也不知道为什么"。
 * 站内信先落库（用户关闭站内信时只隐藏），外部通道按级别 × 开关 × 静默时段
 * 决定立即发、延后发还是聚合为摘要——具体规则见 services/notifications/policy.ts。
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    const now = new Date();
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        email: true,
        emailNotify: true,
        settings: {
          select: {
            notifyEmail: true,
            notifyInapp: true,
            notifyPush: true,
            quietHoursEnabled: true,
            quietStart: true,
            quietEnd: true,
            timezone: true,
          },
        },
      },
    });

    // 账号已注销/删除的用户不再触达（其历史内容已匿名保留）
    if (!user) return;

    const s: NonNullable<UserSettingsRow> = { ...DEFAULT_SETTINGS, ...(user.settings ?? {}) };
    const quiet: QuietHoursSettings = {
      enabled: s.quietHoursEnabled,
      startMin: s.quietStart,
      endMin: s.quietEnd,
      timezone: s.timezone,
    };

    const plan = planDelivery({
      type: input.type,
      level: input.level,
      now,
      channelPrefs: {
        inapp: s.notifyInapp,
        // User.emailNotify 是账号级邮件开关，settings.notifyEmail 是设置页细开关，两者都要开
        email: user.emailNotify && s.notifyEmail,
        webpush: s.notifyPush,
      },
      quiet,
    });

    const notification = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        level: levelOf(input.type, input.level),
        title: input.title.slice(0, 80),
        body: input.body?.slice(0, 300) ?? null,
        payload: toJsonValue(input.payload ?? {}),
        inappHidden: !plan.inapp,
        deliverAt: plan.deliverAt,
        // 立即发的通道记当下意图，延迟/摘要的通道记"到点该走哪些"——补发据此决策
        channels: toJsonValue({
          email: plan.email || plan.deferredChannels.email,
          webpush: plan.webpush || plan.deferredChannels.webpush,
        }),
      },
    });

    if (plan.deliverAt) {
      // 静默延后或低级别聚合：交给 worker 的定时扫描，不在请求路径上等待
      logger.debug(
        { userId: input.userId.toString(), type: input.type, deliverAt: plan.deliverAt.toISOString() },
        plan.digest ? "通知已排队进入摘要" : "通知已延后到静默结束",
      );
      return;
    }

    await dispatchExternal({
      notificationId: notification.id,
      userId: input.userId,
      type: input.type,
      title: notification.title,
      body: notification.body,
      channels: { email: plan.email, webpush: plan.webpush },
    });
  } catch (error) {
    logger.error(
      { err: (error as Error).message, userId: input.userId.toString(), type: input.type },
      "通知创建失败",
    );
  }
}

interface DispatchInput {
  notificationId: bigint;
  userId: bigint;
  type: string;
  title: string;
  body: string | null;
  channels: { email: boolean; webpush: boolean };
}

/** 站内点击直达的路径；与前端路由一一对应 */
function targetUrl(type: string, payload: unknown): string | undefined {
  const p = (payload ?? {}) as { spotUuid?: string };
  if (p.spotUuid) {
    if (type === "review_changes" || type === "spot_stale") {
      return `${env.FRONTEND_BASE_URL}/spots/${p.spotUuid}/edit`;
    }
    return `${env.FRONTEND_BASE_URL}/spots/${p.spotUuid}`;
  }
  if (type === "notification_digest") return `${env.FRONTEND_BASE_URL}/me/notifications`;
  return undefined;
}

/**
 * 立即投递外部通道。邮件与推送互不阻塞；
 * 任一条成功/失败都回写状态，失败的记录会被 worker 的兜底扫描重试。
 */
export async function dispatchExternal(input: DispatchInput): Promise<void> {
  const [row, user] = await Promise.all([
    prisma.notification.findUnique({ where: { id: input.notificationId }, select: { payload: true } }),
    // 邮件需要地址；延后补发时通知对象手上没有用户信息，统一在这里查
    input.channels.email
      ? prisma.user.findUnique({
          where: { id: input.userId },
          select: { email: true, emailNotify: true },
        })
      : Promise.resolve(null),
  ]);
  const url = targetUrl(input.type, row?.payload);
  const email = user?.emailNotify ? (user.email ?? null) : null;
  const text = `${input.body ?? NOTIFICATION_TYPES[input.type as NotificationType] ?? "你有一条新通知"}\n\n${
    url ? `查看详情：${url}\n\n` : ""
  }如需管理通知方式与静默时段，请登录站点设置。`;

  await Promise.all([
    input.channels.email && email
      ? sendMail({ to: email, subject: `[公共空间细节地图] ${input.title}`, text }).then(
          async (sent) => {
            if (sent) {
              await prisma.notification.update({
                where: { id: input.notificationId },
                data: { emailSent: true },
              });
            }
          },
        )
      : Promise.resolve(),

    input.channels.webpush
      ? dispatchPush(input.notificationId, input.userId, input.title, input.body, url)
      : Promise.resolve(),
  ]);
}

async function dispatchPush(
  notificationId: bigint,
  userId: bigint,
  title: string,
  body: string | null,
  url: string | undefined,
): Promise<void> {
  if (!isPushConfigured()) return;

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return;

  let anySent = false;
  for (const sub of subscriptions) {
    const result = await sendPush(sub, { title, body: body ?? "", url });
    if (result === "sent") anySent = true;
    if (result === "gone") {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
    } else if (result === "failed") {
      await prisma.pushSubscription
        .update({ where: { endpoint: sub.endpoint }, data: { lastErrorAt: new Date() } })
        .catch(() => undefined);
    }
  }

  if (anySent) {
    await prisma.notification.update({ where: { id: notificationId }, data: { pushSent: true } });
  }
}
