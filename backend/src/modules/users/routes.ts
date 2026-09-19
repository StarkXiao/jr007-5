import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { supportedTimezones } from "../../services/notifications/timezones";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { logger } from "../../utils/logger";

export const usersRouter = Router();

export const settingsBodySchema = z.object({
  defaultFuzzRadius: z.number().int().min(0).max(500).optional(),
  notifyEmail: z.boolean().optional(),
  notifyInapp: z.boolean().optional(),
  notifyPush: z.boolean().optional(),
  quietHoursEnabled: z.boolean().optional(),
  // 静默起止均为用户时区下自午夜起的分钟数，0–1439
  quietStart: z.number().int().min(0).max(1439).optional(),
  quietEnd: z.number().int().min(0).max(1439).optional(),
  timezone: z.enum(supportedTimezones as unknown as [string, ...string[]]).optional(),
  locale: z.enum(["zh-CN", "en-US"]).optional(),
});

usersRouter.get(
  "/me/settings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await prisma.userSetting.findUnique({ where: { userId: req.user!.id } });
    res.json(
      ok(req, {
        settings: settings ?? {
          defaultFuzzRadius: 50,
          notifyEmail: true,
          notifyInapp: true,
          notifyPush: false,
          quietHoursEnabled: false,
          quietStart: 1320,
          quietEnd: 480,
          timezone: "Asia/Shanghai",
          locale: "zh-CN",
        },
      }),
    );
  }),
);

usersRouter.patch(
  "/me/settings",
  requireAuth,
  validate({ body: settingsBodySchema }),
  asyncHandler(async (req, res) => {
    // 静默起止相同会导致"全天静默"，重要通知照样发，但普通通知永远延后——必须拒绝
    if (
      req.body.quietHoursEnabled &&
      req.body.quietStart !== undefined &&
      req.body.quietEnd !== undefined &&
      req.body.quietStart === req.body.quietEnd
    ) {
      throw AppError.badRequest("静默开始与结束时间不能相同");
    }

    const settings = await prisma.userSetting.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...req.body },
      update: req.body,
    });
    res.json(ok(req, { settings }));
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
