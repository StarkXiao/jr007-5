import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { prisma } from "../../db/prisma";
import { serializeNotification } from "../shared/serialize";
import { getVapidPublicKey, isPushConfigured } from "../../services/notifications/webpush";

export const notificationsRouter = Router();

notificationsRouter.get(
  "/notifications",
  requireAuth,
  validate({
    query: z.object({
      unreadOnly: z.coerce.boolean().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { unreadOnly?: boolean; page: number; pageSize: number };
    // 用户关闭站内信通道时，通知只作外部触达的账本，不进通知中心/未读数
    const where = {
      userId: req.user!.id,
      inappHidden: false,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };
    const skip = (query.page - 1) * query.pageSize;

    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: query.pageSize,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { userId: req.user!.id, readAt: null, inappHidden: false },
      }),
    ]);

    res.json(
      ok(req, {
        items: items.map(serializeNotification),
        page: query.page,
        pageSize: query.pageSize,
        total,
        unread,
      }),
    );
  }),
);

// 不传 ids 表示全部标记已读
notificationsRouter.post(
  "/notifications/read",
  requireAuth,
  validate({
    body: z.object({ ids: z.array(z.coerce.bigint()).max(500).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const ids = req.body.ids as bigint[] | undefined;

    const result = await prisma.notification.updateMany({
      where: {
        userId: req.user!.id,
        readAt: null,
        inappHidden: false,
        ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      },
      data: { readAt: new Date() },
    });

    const unread = await prisma.notification.count({
      where: { userId: req.user!.id, readAt: null, inappHidden: false },
    });

    res.json(ok(req, { marked: result.count, unread }));
  }),
);

/**
 * 浏览器推送（Web Push / VAPID）。
 * 前端拿到 VAPID 公钥 → navigator.serviceWorker → pushManager.subscribe →
 * 把 subscription 回传这里。同一 endpoint 覆盖更新，多设备天然共存。
 */
notificationsRouter.get(
  "/notifications/push/vapid-key",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(
      ok(req, {
        enabled: isPushConfigured(),
        publicKey: isPushConfigured() ? getVapidPublicKey() : null,
      }),
    );
  }),
);

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(60).max(256),
    auth: z.string().min(16).max(64),
  }),
});

notificationsRouter.post(
  "/notifications/push/subscriptions",
  requireAuth,
  validate({ body: pushSubscriptionSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof pushSubscriptionSchema>;
    const userAgent = req.headers["user-agent"]?.slice(0, 256) ?? null;

    // 同一浏览器（endpoint 唯一）重新订阅时，更新归属用户而不是报唯一键冲突
    const existing = await prisma.pushSubscription.findUnique({
      where: { endpoint: body.endpoint },
      select: { id: true, userId: true },
    });

    if (existing) {
      await prisma.pushSubscription.update({
        where: { endpoint: body.endpoint },
        data: {
          userId: req.user!.id,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent,
          lastErrorAt: null,
        },
      });
    } else {
      await prisma.pushSubscription.create({
        data: {
          userId: req.user!.id,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent,
        },
      });
    }

    res.json(ok(req, { subscribed: true }));
  }),
);

notificationsRouter.get(
  "/notifications/push/subscriptions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const count = await prisma.pushSubscription.count({ where: { userId: req.user!.id } });
    res.json(ok(req, { count }));
  }),
);

// 用户在设置页关闭推送时调用；不按 endpoint 删是因为同账号可能有多台设备，
// 关闭总开关即全部撤销（订阅记录保留也无害，通道开关在发送决策处拦截）。
notificationsRouter.delete(
  "/notifications/push/subscriptions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const endpoint = typeof req.query.endpoint === "string" ? req.query.endpoint : undefined;
    const result = await prisma.pushSubscription.deleteMany({
      where: endpoint
        ? { userId: req.user!.id, endpoint }
        : { userId: req.user!.id },
    });
    res.json(ok(req, { removed: result.count }));
  }),
);
