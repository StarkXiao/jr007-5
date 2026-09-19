import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { prisma } from "../../db/prisma";
import { serializeNotification } from "../shared/serialize";
import { NOTIFICATION_LEVELS } from "../../config/constants";

export const notificationsRouter = Router();

notificationsRouter.get(
  "/notifications",
  requireAuth,
  validate({
    query: z.object({
      unreadOnly: z.coerce.boolean().optional(),
      level: z.enum(NOTIFICATION_LEVELS).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      unreadOnly?: boolean;
      level?: (typeof NOTIFICATION_LEVELS)[number];
      page: number;
      pageSize: number;
    };
    const where = {
      userId: req.user!.id,
      ...(query.unreadOnly ? { readAt: null } : {}),
      ...(query.level ? { level: query.level } : {}),
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
      prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }),
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
        ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      },
      data: { readAt: new Date() },
    });

    const unread = await prisma.notification.count({
      where: { userId: req.user!.id, readAt: null },
    });

    res.json(ok(req, { marked: result.count, unread }));
  }),
);
