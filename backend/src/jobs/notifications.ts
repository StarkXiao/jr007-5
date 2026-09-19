import { prisma } from "../db/prisma";
import { logger } from "../utils/logger";
import { dispatchExternal } from "../services/notify";
import { sendMail } from "../services/mailer";
import { sendPush, isPushConfigured } from "../services/notifications/webpush";
import { env } from "../config/env";

/**
 * 通知投递巡检：worker 每 10 分钟跑一次。
 * 负责两类到期事项：
 * 1. 静默时段内延后的普通通知 → 静默结束后补发邮件/推送；
 * 2. 低级别通知 → 到点（静默结束或每天 09:00）聚合为一条摘要。
 *
 * 用一条带条件的 UPDATE ... RETURNING 原子领取任务，
 * 避免多个 worker / 上一轮还没跑完时重复发送（和审核领取锁同一个思路）。
 */

// 立即投递但外部通道失败的通知，超过这个时间不再重试，避免永久积压
const RETRY_GIVE_UP_MS = 7 * 86400_000;

export async function flushNotifications(now = new Date()): Promise<{
  deferred: number;
  digested: number;
  retried: number;
}> {
  // 1. 原子领取所有到期、尚未消化的通知（含被 digest 聚合的低级别通知）
  const claimed = await prisma.$queryRaw<Array<{ id: bigint; user_id: bigint }>>`
    UPDATE notifications
    SET deliver_at = NULL
    WHERE id IN (
      SELECT id FROM notifications
      WHERE deliver_at IS NOT NULL AND deliver_at <= ${now}
      ORDER BY deliver_at
      LIMIT 500
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id
  `;

  if (claimed.length === 0) return { deferred: 0, digested: 0, retried: await retryStale(now) };

  const rows = await prisma.notification.findMany({
    where: { id: { in: claimed.map((r) => r.id) } },
  });

  const deferred = rows.filter((n) => n.level !== "low");
  const lowByUser = new Map<bigint, typeof rows>();
  for (const row of rows.filter((n) => n.level === "low")) {
    const list = lowByUser.get(row.userId) ?? [];
    list.push(row);
    lowByUser.set(row.userId, list);
  }

  // 2. 延后的普通通知：逐条补发外部通道。
  //    走哪些通道以通知产生时记录的 channels 决策为准，避免补发时
  //    把用户当时已关闭的通道又打开；发送状态保证幂等不重复发。
  for (const n of deferred) {
    const planned = (n.channels ?? {}) as { email?: boolean; webpush?: boolean };
    await dispatchExternal({
      notificationId: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      body: n.body,
      channels: {
        email: Boolean(planned.email) && !n.emailSent,
        webpush: Boolean(planned.webpush) && !n.pushSent,
      },
    }).catch((error) => {
      logger.warn({ err: (error as Error).message, id: n.id.toString() }, "延后通知补发失败");
    });
  }

  // 3. 低级别通知：按用户聚合为摘要
  let digested = 0;
  for (const [userId, items] of lowByUser) {
    try {
      await sendDigest(userId, items);
      digested += items.length;
    } catch (error) {
      // 摘要失败：把 deliverAt 推到 10 分钟后重试，不能丢
      logger.warn({ err: (error as Error).message, userId: userId.toString() }, "通知摘要生成失败");
      await prisma.notification.updateMany({
        where: { id: { in: items.map((i) => i.id) } },
        data: { deliverAt: new Date(now.getTime() + 10 * 60_000) },
      });
    }
  }

  const retried = await retryStale(now);
  return { deferred: deferred.length, digested, retried };
}

async function sendDigest(
  userId: bigint,
  items: Array<{ id: bigint; title: string; body: string | null; type: string }>,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      emailNotify: true,
      settings: {
        select: {
          notifyInapp: true,
          notifyEmail: true,
          notifyPush: true,
        },
      },
    },
  });
  if (!user) {
    // 用户已注销：直接把这些通知标记消化掉
    await prisma.notification.updateMany({
      where: { id: { in: items.map((i) => i.id) } },
      data: { deliverAt: null },
    });
    return;
  }

  const title = `你有 ${items.length} 条新通知`;
  const body = items.map((i, idx) => `${idx + 1}. ${i.title}`).join("\n");
  const url = `${env.FRONTEND_BASE_URL}/me/notifications`;

  const digest = await prisma.notification.create({
    data: {
      userId,
      type: "notification_digest",
      level: "low",
      title: title.slice(0, 80),
      body: body.slice(0, 300),
      payload: { count: items.length, ids: items.map((i) => i.id.toString()) },
      inappHidden: user.settings ? !user.settings.notifyInapp : false,
    },
  });

  await prisma.notification.updateMany({
    where: { id: { in: items.map((i) => i.id) } },
    data: { digestId: digest.id, deliverAt: null },
  });

  const wantEmail = user.emailNotify && (user.settings?.notifyEmail ?? true);
  const wantPush = user.settings?.notifyPush ?? false;

  await Promise.all([
    wantEmail && user.email
      ? sendMail({
          to: user.email,
          subject: `[公共空间细节地图] ${title}`,
          text: `${body}\n\n查看全部：${url}`,
        }).then(async (sent) => {
          if (sent) {
            await prisma.notification.update({ where: { id: digest.id }, data: { emailSent: true } });
          }
        })
      : Promise.resolve(),

    wantPush && isPushConfigured()
      ? digestPush(userId, title, body, url, digest.id)
      : Promise.resolve(),
  ]);
}

async function digestPush(
  userId: bigint,
  title: string,
  body: string,
  url: string,
  digestId: bigint,
): Promise<void> {
  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  let anySent = false;
  for (const sub of subscriptions) {
    const result = await sendPush(sub, { title, body, url });
    if (result === "sent") anySent = true;
    if (result === "gone") await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
  }
  if (anySent) {
    await prisma.notification.update({ where: { id: digestId }, data: { pushSent: true } });
  }
}

/**
 * 兜底重试：立即投递的通知如果外部通道一直没成功（比如 SMTP 短暂宕机），
 * 在这里补发；超过 RETRY_GIVE_UP_MS 仍失败的标记放弃，避免无限重试。
 */
async function retryStale(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 10 * 60_000);
  const giveUp = new Date(now.getTime() - RETRY_GIVE_UP_MS);

  const stale = await prisma.notification.findMany({
    where: {
      deliverAt: null,
      level: { in: ["high", "normal"] },
      createdAt: { lt: cutoff },
      OR: [{ emailSent: false }, { pushSent: false }],
    },
    take: 200,
    orderBy: { createdAt: "asc" },
  });

  let retried = 0;
  for (const n of stale) {
    // 放弃重试前要确认通道确实开着且有可达目标，否则只是"没发"而不是"发送失败"
    const planned = (n.channels ?? {}) as { email?: boolean; webpush?: boolean };
    const user = await prisma.user.findUnique({
      where: { id: n.userId },
      select: {
        email: true,
        emailNotify: true,
        settings: { select: { notifyEmail: true, notifyPush: true } },
        pushSubscriptions: { select: { id: true } },
      },
    });
    if (!user) continue;

    const emailEnabled = Boolean(user.email && user.emailNotify && (user.settings?.notifyEmail ?? true));
    // VAPID 未配置时推送通道在部署层面停用，pushSent 保持 false 不算"发送失败"
    const pushEnabled =
      isPushConfigured() && (user.settings?.notifyPush ?? false) && user.pushSubscriptions.length > 0;

    const wantEmail = emailEnabled && Boolean(planned.email) && !n.emailSent;
    const wantPush = pushEnabled && Boolean(planned.webpush) && !n.pushSent;

    if (n.createdAt < giveUp) {
      // 通道本就关闭（例如没有推送订阅）不算失败；真正发送失败的也在 7 天后放弃
      await prisma.notification.update({
        where: { id: n.id },
        data: {
          emailSent: n.emailSent || !wantEmail,
          pushSent: n.pushSent || !wantPush,
        },
      });
      continue;
    }

    if (!wantEmail && !wantPush) continue;

    await dispatchExternal({
      notificationId: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      body: n.body,
      channels: { email: wantEmail, webpush: wantPush },
    }).catch(() => undefined);
    retried += 1;
  }
  return retried;
}
