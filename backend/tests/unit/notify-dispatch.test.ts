import { describe, expect, it, vi, beforeEach } from "vitest";

// 必须在 import 被测模块之前 mock 掉外部依赖
vi.mock("../../src/db/prisma", () => {
  const store = {
    notifications: new Map<string, any>(),
    users: new Map<string, any>(),
    settings: new Map<string, any>(),
    subscriptions: new Map<string, any>(),
    seq: { notification: 100, sub: 1 },
  };

  const key = (id: unknown) => (typeof id === "bigint" ? id.toString() : String(id));

  return {
    toJsonValue: (v: unknown) => JSON.parse(JSON.stringify(v ?? {})),
    prisma: {
      notification: {
        create: vi.fn(async ({ data }: any) => {
          const id = BigInt(++store.seq.notification);
          const row = { id, ...data };
          store.notifications.set(key(id), row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          const row = store.notifications.get(key(where.id));
          if (!row) return null;
          // 模拟 Prisma include: { user: ... }
          return {
            ...row,
            user: store.users.get(key(row.userId))
              ? {
                  id: row.userId,
                  email: store.users.get(key(row.userId)).email,
                  settings: store.settings.get(key(row.userId))
                    ? {
                        notifyEmail: store.settings.get(key(row.userId)).notifyEmail,
                        notifyPush: store.settings.get(key(row.userId)).notifyPush,
                      }
                    : null,
                }
              : null,
          };
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = store.notifications.get(key(where.id));
          if (row) Object.assign(row, data);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const row of store.notifications.values()) {
            if (where.id?.in?.some((id: bigint) => key(id) === key(row.id))) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return { count };
        }),
        findMany: vi.fn(async ({ where }: any) => {
          const now = where.deferredUntil?.lte ?? new Date(8640000000000000);
          return [...store.notifications.values()].filter(
            (r: any) =>
              (where.OR ?? []).some((c: any) => Object.entries(c).some(([k, v]) => r[k] === v)) &&
              r.deferredUntil &&
              r.deferredUntil <= now,
          );
        }),
      },
      user: {
        // 合并 settings 行，模拟 Prisma 关系 include
        findUnique: vi.fn(async ({ where }: any) => {
          const user = store.users.get(key(where.id));
          if (!user) return null;
          const settings = store.settings.get(key(where.id));
          return { ...user, settings: settings ? { ...settings } : null };
        }),
      },
      userSetting: {
        findUnique: vi.fn(async ({ where }: any) => store.settings.get(key(where.userId)) ?? null),
      },
      pushSubscription: {
        findMany: vi.fn(async ({ where }: any) =>
          [...store.subscriptions.values()].filter(
            (s: any) => s.userId === where.userId && (!where.expired || s.expired === false),
          ),
        ),
        // 这两个在真实 Prisma 上是异步写操作，必须返回 Promise；
        // 空 vi.fn() 返回 undefined，.catch 会抛 TypeError，导致后面的状态回写被跳过
        update: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      _store: store,
    },
  };
});

const mails: Array<{ to: string; subject: string; text: string }> = [];
vi.mock("../../src/services/mailer", () => ({
  sendMail: vi.fn(async (m: any) => {
    mails.push(m);
    return true;
  }),
}));

const pushes: Array<{ endpoint: string }> = [];
vi.mock("../../src/services/push", () => ({
  // 未配置 VAPID 时 sender 自身会返回 skipped，这里模拟发送成功
  sendPush: vi.fn(async (target: any) => {
    pushes.push(target);
    return "sent";
  }),
}));

vi.mock("../../src/services/queue", () => ({
  // 同步直投，绕过 BullMQ/Redis
  enqueueNotifyJob: vi.fn(async () => false),
}));

import { notify } from "../../src/services/notify";
import { flushDeferredNotifications } from "../../src/services/notify";
import { prisma } from "../../src/db/prisma";

// mock 模块的内部存储，用于造数据
const store = (prisma as any)._store as {
  notifications: Map<string, any>;
  users: Map<string, any>;
  settings: Map<string, any>;
  subscriptions: Map<string, any>;
};

const USER_ID = 1n;

function setupUser(settingsOverrides: Record<string, unknown> = {}) {
  store.users.set(USER_ID.toString(), {
    id: USER_ID,
    email: "u@example.com",
    settings: { notifyEmail: true, notifyPush: true },
  });
  store.settings.set(USER_ID.toString(), {
    userId: USER_ID,
    notifyEmail: true,
    notifyPush: true,
    emailMinLevel: "important",
    pushMinLevel: "normal",
    quietHoursEnabled: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    timeZone: "Asia/Shanghai",
    ...settingsOverrides,
  } as any);
  store.subscriptions.set("1", {
    id: 1n,
    userId: USER_ID,
    endpoint: "https://push.example.com/device-1",
    p256dh: "pk",
    auth: "au",
    expired: false,
  });
}

beforeEach(() => {
  store.notifications.clear();
  store.users.clear();
  store.settings.clear();
  store.subscriptions.clear();
  mails.length = 0;
  pushes.length = 0;
});

describe("notify() 统一分流与投递", () => {
  it("白天的重要通知：邮件+推送+站内信全部发出", async () => {
    setupUser();
    // UTC 06:00 = 上海 14:00（未启用静默，其实时间无所谓）
    vi.setSystemTime(new Date("2026-09-19T06:00:00Z"));

    await notify({ userId: USER_ID, type: "review_rejected", title: "未通过", body: "原因" });

    const row = [...store.notifications.values()][0];
    expect(row.level).toBe("important");
    expect(row.inappStatus).toBe("sent");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("u@example.com");
    expect(pushes).toHaveLength(1);
    expect(row.emailStatus).toBe("sent");
    expect(row.pushStatus).toBe("sent");
  });

  it("普通通知默认不发邮件，只走推送+站内信", async () => {
    setupUser();

    await notify({ userId: USER_ID, type: "comment_reply", title: "回复" });

    expect(mails).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    const row = [...store.notifications.values()][0];
    expect(row.emailStatus).toBe("skipped");
    expect(row.pushStatus).toBe("sent");
  });

  it("静默时段内普通/重要通知暂缓，记录 deferred_until，不触发外部通道", async () => {
    setupUser({ quietHoursEnabled: true });
    vi.setSystemTime(new Date("2026-09-19T15:00:00Z")); // 上海 23:00

    await notify({ userId: USER_ID, type: "review_changes", title: "需要修改", body: "三点" });

    expect(mails).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    const row = [...store.notifications.values()][0];
    expect(row.emailStatus).toBe("deferred");
    expect(row.pushStatus).toBe("deferred");
    expect(row.deferredUntil).toBeInstanceOf(Date);
    // 暂缓到本地次日 08:00 = UTC 次日 00:00
    expect(row.deferredUntil.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("紧急通知在静默时段也立即发送", async () => {
    setupUser({ quietHoursEnabled: true });
    vi.setSystemTime(new Date("2026-09-19T15:00:00Z"));

    await notify({
      userId: USER_ID,
      type: "security_alert",
      title: "异常登录",
      body: "深圳",
    });

    expect(mails).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    const row = [...store.notifications.values()][0];
    expect(row.emailStatus).toBe("sent");
    expect(row.pushStatus).toBe("sent");
    expect(row.deferredUntil).toBeNull();
    expect(mails[0].subject).toContain("[紧急]");
  });

  it("用户关闭邮件通道后，即使重要通知也只走推送", async () => {
    setupUser({ notifyEmail: false });

    await notify({ userId: USER_ID, type: "review_rejected", title: "驳回" });

    expect(mails).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    const row = [...store.notifications.values()][0];
    expect(row.emailStatus).toBe("skipped");
  });

  it("未绑定邮箱时邮件状态记 skipped，不影响推送", async () => {
    setupUser();
    store.users.get(USER_ID.toString())!.email = null;

    await notify({ userId: USER_ID, type: "review_rejected", title: "驳回" });

    expect(pushes).toHaveLength(1);
    const row = [...store.notifications.values()][0];
    expect(row.emailStatus).toBe("skipped");
  });
});

describe("flushDeferredNotifications() 静默后补发", () => {
  it("同一用户多条暂缓邮件合并成一封摘要，推送逐条补发", async () => {
    setupUser({ quietHoursEnabled: true });

    // 直接造两条暂缓通知（模拟夜间写入）
    const make = (id: bigint, over: Record<string, unknown>) => ({
      id,
      userId: USER_ID,
      inappStatus: "sent",
      deferredUntil: new Date("2026-09-20T00:00:00Z"),
      createdAt: new Date("2026-09-19T14:30:00Z"),
      ...over,
    });
    store.notifications.set(
      "1001",
      make(1001n, { type: "review_rejected", level: "important", title: "未通过", body: "理由A", emailStatus: "deferred", pushStatus: "deferred" }) as any,
    );
    store.notifications.set(
      "1002",
      make(1002n, { type: "review_changes", level: "important", title: "需要修改", body: "理由B", emailStatus: "deferred", pushStatus: "deferred" }) as any,
    );

    vi.setSystemTime(new Date("2026-09-20T00:05:00Z"));
    const result = await flushDeferredNotifications(new Date("2026-09-20T00:05:00Z"));

    expect(result.emails).toBe(2); // 两条记录都标记为 sent
    expect(result.pushes).toBe(2);
    // 但只发出一封邮件（摘要）
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain("2 条新通知");
    expect(mails[0].text).toContain("未通过");
    expect(mails[0].text).toContain("需要修改");
    // 推送是逐条的
    expect(pushes).toHaveLength(2);

    for (const id of [1001n, 1002n]) {
      const row = store.notifications.get(id.toString())!;
      expect(row.emailStatus).toBe("sent");
      expect(row.pushStatus).toBe("sent");
      expect(row.deferredUntil).toBeNull();
    }
  });
});
