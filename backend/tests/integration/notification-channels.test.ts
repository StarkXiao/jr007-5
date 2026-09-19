import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";
import { notify } from "../../src/services/notify";
import { flushNotifications } from "../../src/jobs/notifications";

/**
 * 三通道统一触达 + 分级 + 静默时段的端到端验证：
 * 直接调用 notify() 制造事件（MAIL_DRIVER=console 下邮件必"成功"），
 * 再从 API 和数据库两侧观察落库、延后、摘要、推送订阅与通知中心过滤。
 */
let app: Express;
let token = "";
let userUuid = "";
let userId = 0n;

const suffix = Date.now().toString(36);
const userEmail = `channels-${suffix}@example.com`;
const password = "Str0ngPass1";

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: userEmail, password, nickname: `通道测试${suffix.slice(-4)}` })
    .expect(201);

  const login = await request(app).post("/api/v1/auth/login").send({ account: userEmail, password }).expect(200);
  token = login.body.data.accessToken;

  const record = await prisma.user.findUniqueOrThrow({ where: { email: userEmail } });
  userId = record.id;
  userUuid = record.uuid;
}, 60000);

afterAll(async () => {
  await prisma.pushSubscription.deleteMany({ where: { userId } });
  await prisma.notification.deleteMany({ where: { userId } });
  await prisma.userSetting.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}, 60000);

describe("分级落库", () => {
  it("通知带级别，且申诉结果属于 high、过期提醒属于 low", async () => {
    await notify({ userId, type: "appeal_result", title: "申诉结果重要", payload: {} });
    await notify({ userId, type: "spot_stale", title: "条目可能过期", payload: {} });

    const high = await prisma.notification.findFirstOrThrow({
      where: { userId, type: "appeal_result" },
      orderBy: { createdAt: "desc" },
    });
    const low = await prisma.notification.findFirstOrThrow({
      where: { userId, type: "spot_stale" },
      orderBy: { createdAt: "desc" },
    });

    expect(high.level).toBe("high");
    expect(low.level).toBe("low");
    expect(high.deliverAt).toBeNull();
  });

  it("级别与通道状态会通过通知列表 API 暴露", async () => {
    const response = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const items = response.body.data.items as Array<{
      type: string;
      level: string;
      channels: { email: boolean; webpush: boolean };
    }>;
    const appeal = items.find((item) => item.type === "appeal_result");
    expect(appeal?.level).toBe("high");
    expect(appeal?.channels).toEqual({ email: true, webpush: false });
  });
});

describe("静默时段", () => {
  const markers = { high: "", normal: "", low: "" };

  beforeAll(async () => {
    // 用一个固定的静默窗口：本地 00:00–23:59（全天静默，仅结束边界放开一分钟），
    // 这样在测试运行的任意时刻，普通通知都必然被延后。
    await prisma.userSetting.upsert({
      where: { userId },
      create: {
        userId,
        notifyEmail: true,
        notifyInapp: true,
        notifyPush: false,
        quietHoursEnabled: true,
        quietStart: 0,
        quietEnd: 1439,
        timezone: "Asia/Shanghai",
      },
      update: {
        notifyEmail: true,
        notifyInapp: true,
        quietHoursEnabled: true,
        quietStart: 0,
        quietEnd: 1439,
      },
    });

    const mark = Date.now();
    markers.high = `审核驳回${mark}`;
    markers.normal = `收到回复${mark}`;
    markers.low = `过期提醒${mark}`;

    await notify({ userId, type: "review_rejected", title: markers.high, payload: {} });
    await notify({ userId, type: "comment_reply", title: markers.normal, payload: {} });
    await notify({ userId, type: "spot_stale", title: markers.low, payload: {} });
  });

  it("high 通知在静默期立即发送邮件，普通通知延后、低级别通知排队进摘要", async () => {
    const high = await prisma.notification.findFirstOrThrow({
      where: { userId, title: markers.high },
    });
    const normal = await prisma.notification.findFirstOrThrow({
      where: { userId, title: markers.normal },
    });
    const low = await prisma.notification.findFirstOrThrow({
      where: { userId, title: markers.low },
    });

    // high：立即发，不排队
    expect(high.deliverAt).toBeNull();
    expect(high.emailSent).toBe(true);

    // normal：延后到静默结束，邮件尚未发出，通道意图已记录
    expect(normal.deliverAt).not.toBeNull();
    expect(normal.emailSent).toBe(false);
    expect((normal.channels as { email: boolean }).email).toBe(true);

    // low：进入摘要队列
    expect(low.deliverAt).not.toBeNull();
    expect((low.channels as { email: boolean }).email).toBe(true);

    // 延后与排队的通知都已进通知中心（站内信不受静默影响）
    const list = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const types = list.body.data.items as Array<{ title: string }>;
    expect(types.some((item) => item.title === markers.normal)).toBe(true);
  });

  it("flush 到期前不补发，把到期时间改到过去后普通通知补发、低级别通知聚合为摘要", async () => {
    // 全天静默窗口下没有到期项
    const resultBefore = await flushNotifications();
    const untouched = await prisma.notification.findFirstOrThrow({
      where: { userId, title: markers.normal },
    });
    expect(untouched.emailSent).toBe(false);
    void resultBefore;

    const normal = await prisma.notification.findFirstOrThrow({
      where: { userId, title: markers.normal },
    });
    const low = await prisma.notification.findFirstOrThrow({
      where: { userId, title: markers.low },
    });

    // 模拟静默结束：把计划投递时刻拨到过去
    await prisma.notification.updateMany({
      where: { id: { in: [normal.id, low.id] } },
      data: { deliverAt: new Date(Date.now() - 60_000) },
    });

    const result = await flushNotifications();
    expect(result.deferred).toBeGreaterThanOrEqual(1);
    expect(result.digested).toBeGreaterThanOrEqual(1);

    const normalAfter = await prisma.notification.findUniqueOrThrow({ where: { id: normal.id } });
    expect(normalAfter.deliverAt).toBeNull();
    expect(normalAfter.emailSent).toBe(true);

    const lowAfter = await prisma.notification.findUniqueOrThrow({ where: { id: low.id } });
    expect(lowAfter.deliverAt).toBeNull();
    expect(lowAfter.digestId).not.toBeNull();

    const digest = await prisma.notification.findUniqueOrThrow({ where: { id: lowAfter.digestId! } });
    expect(digest.type).toBe("notification_digest");
    expect(digest.emailSent).toBe(true);
    expect((digest.payload as { count: number }).count).toBeGreaterThanOrEqual(1);
  });
});

describe("通道开关", () => {
  it("关闭站内信后通知不进通知中心、不计未读，但邮件照常发送", async () => {
    await prisma.userSetting.update({
      where: { userId },
      data: {
        notifyInapp: false,
        notifyEmail: true,
        quietHoursEnabled: false,
      },
    });

    const mark = `隐藏测试${Date.now()}`;
    await notify({ userId, type: "review_approved", title: mark, payload: {} });

    const row = await prisma.notification.findFirstOrThrow({
      where: { userId, title: mark },
    });
    expect(row.inappHidden).toBe(true);
    expect(row.emailSent).toBe(true);

    const list = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const items = list.body.data.items as Array<{ title: string }>;
    expect(items.some((item) => item.title === mark)).toBe(false);
  });

  it("设置接口校验静默起止与分钟范围", async () => {
    const bad = await request(app)
      .patch("/api/v1/me/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ quietHoursEnabled: true, quietStart: 600, quietEnd: 600 });
    expect(bad.status).toBe(400);

    const outOfRange = await request(app)
      .patch("/api/v1/me/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ quietStart: 1440 });
    expect(outOfRange.status).toBe(400);

    const okResponse = await request(app)
      .patch("/api/v1/me/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        notifyInapp: true,
        notifyEmail: true,
        notifyPush: false,
        quietHoursEnabled: true,
        quietStart: 1320,
        quietEnd: 480,
        timezone: "Asia/Shanghai",
      })
      .expect(200);
    expect(okResponse.body.data.settings.quietStart).toBe(1320);
  });
});

function startGonePushServer(): Promise<{ server: https.Server; baseUrl: string; cleanup: () => void }> {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-cert-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
       "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"],
      { stdio: "ignore" },
    );

    const server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      (_req, res) => {
        res.statusCode = 410;
        res.end("Gone");
      },
    );

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        baseUrl: `https://127.0.0.1:${port}`,
        cleanup: () => {
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 生成一对符合 Push API 曲线要求（P-256）的订阅密钥 */
function generatePushKeys(): { p256dh: string; auth: string } {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(crypto.randomBytes(16)) };
}

describe("浏览器推送订阅", () => {
  it("VAPID 配置状态可取", async () => {
    const response = await request(app)
      .get("/api/v1/notifications/push/vapid-key")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    // 测试环境是否配置 VAPID 取决于环境变量，只断言结构
    expect(typeof response.body.data.enabled).toBe("boolean");
    if (response.body.data.enabled) expect(typeof response.body.data.publicKey).toBe("string");
  });

  it("同一 endpoint 重新订阅覆盖归属，删除接口可撤销", async () => {
    const body = {
      endpoint: "https://push.example.net/test-subscription-endpoint-unique",
      keys: generatePushKeys(),
    };

    await request(app)
      .post("/api/v1/notifications/push/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(200);

    // 再发一次不应触发唯一键冲突
    await request(app)
      .post("/api/v1/notifications/push/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(200);

    const countResponse = await request(app)
      .get("/api/v1/notifications/push/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(countResponse.body.data.count).toBe(1);

    const removed = await request(app)
      .del("/api/v1/notifications/push/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(removed.body.data.removed).toBe(1);
  });

  it("订阅参数不合法时被拒", async () => {
    const response = await request(app)
      .post("/api/v1/notifications/push/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ endpoint: "not-a-url", keys: { p256dh: "x", auth: "y" } });
    expect(response.status).toBe(400);
  });

  it("推送服务返回 410 时失效订阅会被自动清理", async () => {
    const configured = (
      await request(app)
        .get("/api/v1/notifications/push/vapid-key")
        .set("Authorization", `Bearer ${token}`)
        .expect(200)
    ).body.data.enabled as boolean;

    if (!configured) return;

    const oldRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const { baseUrl, cleanup } = await startGonePushServer();
    const endpoint = `${baseUrl}/stale-device-push-endpoint`;

    try {
      await request(app)
        .post("/api/v1/notifications/push/subscriptions")
        .set("Authorization", `Bearer ${token}`)
        .send({
          endpoint,
          keys: generatePushKeys(),
        })
        .expect(200);

      await prisma.userSetting.update({
        where: { userId },
        data: { notifyPush: true, quietHoursEnabled: false, notifyEmail: true, notifyInapp: true },
      });

      await notify({ userId, type: "review_rejected", title: "推送失效清理测试", payload: {} });

      const remaining = await prisma.pushSubscription.count({ where: { endpoint } });
      expect(remaining).toBe(0);
    } finally {
      if (oldRejectUnauthorized === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = oldRejectUnauthorized;
      cleanup();
    }
  });
});
