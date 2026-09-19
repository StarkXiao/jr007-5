import { describe, expect, it } from "vitest";
import {
  isInQuietHours,
  levelAtLeast,
  localMinuteOfDay,
  nextQuietHoursEnd,
  parseHHMM,
  planNotification,
  safeTimeZone,
} from "../../src/services/notify/policy";
import type { NotificationPolicyInput } from "../../src/services/notify/types";

const baseSettings: NotificationPolicyInput["settings"] = {
  notifyEmail: true,
  notifyPush: true,
  emailMinLevel: "important",
  pushMinLevel: "normal",
  quietHoursEnabled: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  timeZone: "Asia/Shanghai",
};

function plan(
  level: NotificationPolicyInput["level"],
  overrides: Partial<NotificationPolicyInput["settings"]> = {},
  // 默认取上海白天 14:00（UTC 06:00），避免静默时段干扰分级用例
  at: Date = new Date("2026-09-19T06:00:00Z"),
) {
  return planNotification({ level, settings: { ...baseSettings, ...overrides } }, at);
}

describe("重要程度分级", () => {
  it("级别顺序为 info < normal < important < critical", () => {
    expect(levelAtLeast("critical", "critical")).toBe(true);
    expect(levelAtLeast("critical", "info")).toBe(true);
    expect(levelAtLeast("normal", "important")).toBe(false);
    expect(levelAtLeast("important", "normal")).toBe(true);
    expect(levelAtLeast("info", "info")).toBe(true);
  });

  it("未达通道阈值时跳过该通道", () => {
    // info 通知：邮件阈值 important、推送阈值 normal，都不该发
    const result = plan("info");
    expect(result.channels.email.action).toBe("skipped");
    expect(result.channels.push.action).toBe("skipped");
    expect(result.channels.inapp.action).toBe("sent");
  });

  it("普通通知只走浏览器推送，不发邮件", () => {
    const result = plan("normal");
    expect(result.channels.email.action).toBe("skipped");
    expect(result.channels.push.action).toBe("sent");
  });

  it("重要通知邮件与推送都发", () => {
    const result = plan("important");
    expect(result.channels.email.action).toBe("sent");
    expect(result.channels.push.action).toBe("sent");
  });

  it("通道总开关关闭时跳过", () => {
    const result = plan("critical", { notifyEmail: false, notifyPush: false });
    expect(result.channels.email.action).toBe("skipped");
    expect(result.channels.push.action).toBe("skipped");
    // 站内信不受任何开关影响
    expect(result.channels.inapp.action).toBe("sent");
  });

  it("用户可调高通道阈值（推送只收紧急）", () => {
    const result = plan("important", { pushMinLevel: "critical" });
    expect(result.channels.email.action).toBe("sent");
    expect(result.channels.push.action).toBe("skipped");
  });
});

describe("静默时段", () => {
  it("HH:MM 解析", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("08:30")).toBe(510);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("8:30")).toBeNull();
    expect(parseHHMM("")).toBeNull();
  });

  it("时区换算：UTC 14:00 对应上海 22:00", () => {
    expect(localMinuteOfDay(new Date("2026-09-19T14:00:00Z"), "Asia/Shanghai")).toBe(22 * 60);
    expect(localMinuteOfDay(new Date("2026-09-19T15:59:00Z"), "Asia/Shanghai")).toBe(23 * 60 + 59);
    expect(localMinuteOfDay(new Date("2026-09-19T16:00:00Z"), "Asia/Shanghai")).toBe(0);
  });

  it("跨午夜窗口内的时刻被识别为静默", () => {
    // 上海 22:00–08:00 静默
    expect(isInQuietHours(new Date("2026-09-19T14:00:00Z"), baseSettings)).toBe(true); // 22:00
    expect(isInQuietHours(new Date("2026-09-19T23:30:00Z"), baseSettings)).toBe(true); // 次日 07:30
    expect(isInQuietHours(new Date("2026-09-19T06:00:00Z"), baseSettings)).toBe(false); // 14:00
    expect(isInQuietHours(new Date("2026-09-19T00:00:00Z"), baseSettings)).toBe(false); // 08:00 已出静默
  });

  it("静默边界为左闭右开：08:00 整不算静默，22:00 整算", () => {
    expect(isInQuietHours(new Date("2026-09-19T00:00:00Z"), baseSettings)).toBe(false); // 本地 08:00
    expect(isInQuietHours(new Date("2026-09-19T14:00:00Z"), baseSettings)).toBe(true); // 本地 22:00
  });

  it("不跨午夜的窗口也能判定", () => {
    const daytime = { ...baseSettings, quietHoursStart: "12:00", quietHoursEnd: "14:00" };
    expect(isInQuietHours(new Date("2026-09-19T05:00:00Z"), daytime)).toBe(true); // 本地 13:00
    expect(isInQuietHours(new Date("2026-09-19T03:00:00Z"), daytime)).toBe(false); // 本地 11:00
  });

  it("起止相同时刻视为全天静默", () => {
    const allDay = { ...baseSettings, quietHoursStart: "09:00", quietHoursEnd: "09:00" };
    expect(isInQuietHours(new Date("2026-09-19T03:00:00Z"), allDay)).toBe(true);
  });

  it("静默时段内非紧急通知暂缓，紧急通知照常立即发送", () => {
    const atNight = new Date("2026-09-19T15:00:00Z"); // 上海 23:00
    const normal = plan("normal", {}, atNight);
    // normal 本身达不到邮件阈值（important），所以邮件是 skipped；推送达标 -> deferred
    expect(normal.channels.email.action).toBe("skipped");
    expect(normal.channels.push.action).toBe("deferred");
    expect(normal.deferredUntil).not.toBeNull();
    expect(normal.deferredUntil!.getTime()).toBeGreaterThan(atNight.getTime());

    const important = plan("important", {}, atNight);
    expect(important.channels.email.action).toBe("deferred");
    expect(important.channels.push.action).toBe("deferred");

    const critical = plan("critical", {}, atNight);
    expect(critical.channels.email.action).toBe("sent");
    expect(critical.channels.push.action).toBe("sent");
    expect(critical.deferredUntil).toBeNull();
  });

  it("关闭静默开关后，夜里也立即发送", () => {
    const atNight = new Date("2026-09-19T15:00:00Z");
    const result = plan("important", { quietHoursEnabled: false }, atNight);
    expect(result.channels.email.action).toBe("sent");
    expect(result.channels.push.action).toBe("sent");
  });

  it("下一个静默结束时刻指向本地次日 08:00", () => {
    // 上海 23:00（UTC 15:00）入睡，窗口次日 08:00 结束 = UTC 次日 00:00
    const from = new Date("2026-09-19T15:00:00Z");
    const end = nextQuietHoursEnd(from, baseSettings);
    expect(localMinuteOfDay(end, "Asia/Shanghai")).toBe(8 * 60);
    expect(end.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("白天调用时下一个结束时刻是次日早上", () => {
    // 上海 9/19 14:00 = UTC 06:00，不在静默期；下一个 08:00 本地是 9/20 08:00 = UTC 9/20 00:00
    const from = new Date("2026-09-19T06:00:00Z");
    const end = nextQuietHoursEnd(from, baseSettings);
    expect(end.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("非法时区回退 UTC，不抛错", () => {
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
    expect(safeTimeZone(undefined)).toBe("UTC");
    expect(safeTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
  });
});

describe("DST 处理", () => {
  it("纽约夏令时切换日的静默结束时刻仍是本地墙上 08:00", () => {
    // 美东 2026-03-08 02:00  clocks forward；静默 22:00-08:00
    const ny = {
      ...baseSettings,
      timeZone: "America/New_York",
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
    };
    // 3/8 03:30 本地（夏令时已切换）= UTC 07:30
    const from = new Date("2026-03-08T07:30:00Z");
    const end = nextQuietHoursEnd(from, ny);
    // 结束应为本地 3/8 08:00（EDT, UTC-4）= UTC 12:00
    expect(end.toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(localMinuteOfDay(end, "America/New_York")).toBe(8 * 60);
  });
});
