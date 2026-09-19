import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { prisma } from "../../db/prisma";
import { logger } from "../../utils/logger";
import {
  DEFAULT_CHANNEL_MIN_LEVEL,
  NOTIFICATION_LEVELS,
} from "../../config/constants";
import { isPushConfigured, vapidPublicKey } from "../../services/push";

export const usersRouter = Router();

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式应为 HH:MM");

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const settingsBodySchema = z
  .object({
    defaultFuzzRadius: z.number().int().min(0).max(500),
    notifyEmail: z.boolean(),
    notifyInapp: z.boolean(),
    notifyPush: z.boolean(),
    emailMinLevel: z.enum(NOTIFICATION_LEVELS),
    pushMinLevel: z.enum(NOTIFICATION_LEVELS),
    quietHoursEnabled: z.boolean(),
    quietHoursStart: hhmm,
    quietHoursEnd: hhmm,
    // IANA 时区名（如 Asia/Shanghai）：静默时段按用户本地时间计算，必须可识别
    timeZone: z.string().min(1).max(64).refine(isValidTimeZone, "无法识别的时区，请使用 IANA 时区名"),
    locale: z.enum(["zh-CN", "en-US"]),
  })
  .partial();

function defaultSettings() {
  return {
    defaultFuzzRadius: 50,
    notifyEmail: true,
    notifyInapp: true,
    notifyPush: false,
    emailMinLevel: DEFAULT_CHANNEL_MIN_LEVEL.email,
    pushMinLevel: DEFAULT_CHANNEL_MIN_LEVEL.push,
    quietHoursEnabled: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    timeZone: "Asia/Shanghai",
    locale: "zh-CN",
  };
}

usersRouter.get(
  "/me/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await prisma.userSetting.findUnique({ where: { userId: req.user!.id } });
    res.json(
      ok(req, {
        settings: settings ?? defaultSettings(),
        // 前端开启浏览器推送时要用 VAPID 公钥订阅；未配置时按钮置灰
        push: { configured: isPushConfigured(), vapidPublicKey: vapidPublicKey() },
      }),
    );
  }),
);

usersRouter.patch(
  "/me/settings",
  requireAuth,
  validate({ body: settingsBodySchema }),
  asyncHandler(async (req, res) => {
    const settings = await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...defaultSettings(), ...req.body },
      update: req.body,
    });
    res.json(ok(req, { settings }));
  }),
);

// ---------------------------------------------------------------- 浏览器推送订阅

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({
    p256dh: z.string().min(20).max(255),
    auth: z.string().min(10).max(255),
  }),
});

usersRouter.get(
  "/me/push-subscription",
  requireAuth,
  asyncHandler(async (req, res) => {
    // 只暴露"是否已订阅"，endpoint/密钥不回传
    const count = await prisma.pushSubscription.count({
      where: { userId: req.user!.id, expired: false },
    });
    res.json(
      ok(req, {
        subscribed: count > 0,
        configured: isPushConfigured(),
        vapidPublicKey: vapidPublicKey(),
      }),
    );
  }),
);

usersRouter.post(
  "/me/push-subscription",
  requireAuth,
  validate({ body: subscriptionSchema }),
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body as z.infer<typeof subscriptionSchema>;
    const endpointHash = crypto.createHash("sha256").update(endpoint).digest("hex");

    // 同一浏览器可能重复点"开启"：endpoint 是推送服务端分配的全局唯一标识，
    // 已存在则把归属更新到当前用户并复用，避免唯一键冲突报错。
    const subscription = await prisma.pushSubscription.upsert({
      where: { endpointHash },
      create: {
        userId: req.user!.id,
        endpoint,
        endpointHash,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
        expired: false,
      },
      update: {
        userId: req.user!.id,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
        expired: false,
      },
    });

    // 订阅了推送即视为希望收到推送，顺手打开总开关，避免"订阅了却永远不响"
    await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, notifyPush: true },
      update: { notifyPush: true },
    });

    logger.info(
      { userId: req.user!.id.toString(), subscriptionId: subscription.id.toString() },
      "浏览器推送订阅已注册",
    );

    res.status(201).json(ok(req, { subscribed: true }));
  }),
);

usersRouter.delete(
  "/me/push-subscription",
  requireAuth,
  validate({ body: z.object({ endpoint: z.string().url().max(1024) }).optional() }),
  asyncHandler(async (req, res) => {
    const endpoint = req.body?.endpoint as string | undefined;

    if (endpoint) {
      const endpointHash = crypto.createHash("sha256").update(endpoint).digest("hex");
      const result = await prisma.pushSubscription.deleteMany({
        where: { endpointHash, userId: req.user!.id },
      });

      // 还有其它设备订阅时保留总开关；删的是最后一台才关闭，避免关掉另一台设备的推送
      const remaining = await prisma.pushSubscription.count({
        where: { userId: req.user!.id, expired: false },
      });
      if (result.count > 0 && remaining === 0) {
        await prisma.userSetting.updateMany({ where: { userId: req.user!.id }, data: { notifyPush: false } });
      }
    } else {
      const result = await prisma.pushSubscription.deleteMany({ where: { userId: req.user!.id } });
      if (result.count > 0) {
        await prisma.userSetting.updateMany({ where: { userId: req.user!.id }, data: { notifyPush: false } });
      }
    }

    res.json(ok(req, { subscribed: false }));
  }),
);

/**
 * 注销账号。
 * 按文档 6.5：个人身份信息匿名化，历史贡献保留但不再关联到具体个人。
 * 这样既不破坏地图完整性，也不给用户留下"删不干净"的担忧。
 */
usersRouter.post(
  "/me/delete-account",
  requireAuth,
  validate({ body: z.object({ confirm: z.literal("DELETE") }) }),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;

    const ownedSpots = await prisma.spot.count({ where: { ownerId: userId, deletedAt: null } });

    await prisma.$transaction([
      prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "account_deleted" },
      }),
      prisma.user.update({
        where: { id: userId },
        data: {
          email: null,
          phone: null,
          nickname: "已注销用户",
          avatarUrl: null,
          passwordHash: crypto.randomBytes(48).toString("hex"),
          status: "deleted",
          deletedAt: new Date(),
        },
      }),
      prisma.userSetting.deleteMany({ where: { userId } }),
      prisma.pushSubscription.deleteMany({ where: { userId } }),
      prisma.favorite.deleteMany({ where: { userId } }),
      prisma.notification.deleteMany({ where: { userId } }),
    ]);

    logger.info({ userId: userId.toString(), ownedSpots }, "用户注销并完成匿名化");

    res.clearCookie("psdm_rt", { path: "/" });
    res.json(
      ok(req, {
        deleted: true,
        message:
          ownedSpots > 0
            ? `账号已注销，你的 ${ownedSpots} 条记录已转为匿名保留在地图上。`
            : "账号已注销。",
      }),
    );
  }),
);
