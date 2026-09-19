import { describe, expect, it } from "vitest";
import {
  isInQuietHours,
  levelAllowsChannel,
  levelOf,
  localMinutesAt,
  nextDigestTime,
  nextQuietEnd,
  planDelivery,
  type QuietHoursSettings,
} from "../../src/services/notifications/policy";

const QUIET_22_8: QuietHoursSettings = {
  enabled: true,
  startMin: 22 * 60,
  endMin: 8 * 60,
  timezone: "Asia/Shanghai",
};
const QUIET_OFF: QuietHoursSettings = { enabled: false, startMin: 1320, endMin: 480, timezone: "Asia/Shanghai" };
const PREFS = { inapp: true, email: true, webpush: true };

describe("通知分级", () => {
  it("申诉结果、驳回、评论被隐藏属于 high", () => {
    expect(levelOf("appeal_result")).toBe("high");
    expect(levelOf("review_rejected")).toBe("high");
    expect(levelOf("comment_hidden")).toBe("high");
  });

  it("常规反馈属于 normal，过期提醒属于 low", () => {
    expect(levelOf("review_approved")).toBe("normal");
    expect(levelOf("comment_reply")).toBe("normal");
    expect(levelOf("spot_stale")).toBe("low");
  });

  it("调用方可显式覆盖级别", () => {
    expect(levelOf("report_result", "high")).toBe("high");
  });

  it("low 级别不走邮件和推送，high/normal 三通道都允许", () => {
    expect(levelAllowsChannel("low", "email")).toBe(false);
    expect(levelAllowsChannel("low", "webpush")).toBe(false);
    expect(levelAllowsChannel("high", "webpush")).toBe(true);
  });
});

describe("静默时段判断", () => {
  it("本地 23:00 在 22:00–08:00 静默期内", () => {
    // UTC 15:00 = 上海 23:00
    expect(isInQuietHours(new Date("2026-09-18T15:00:00Z"), QUIET_22_8)).toBe(true);
  });

  it("本地 07:59 在静默期内，08:00 起不在", () => {
    expect(isInQuietHours(new Date("2026-09-17T23:59:00Z"), QUIET_22_8)).toBe(true);
    expect(isInQuietHours(new Date("2026-09-18T00:00:00Z"), QUIET_22_8)).toBe(false);
  });

  it("本地中午不在静默期", () => {
    expect(isInQuietHours(new Date("2026-09-18T04:00:00Z"), QUIET_22_8)).toBe(false);
  });

  it("关闭静默后任何时刻都不静默", () => {
    expect(isInQuietHours(new Date("2026-09-18T15:00:00Z"), QUIET_OFF)).toBe(false);
  });

  it("非法时区退化为 UTC 而不是抛错", () => {
    expect(
      localMinutesAt(new Date("2026-09-18T10:30:00Z"), "Not/AZone"),
    ).toBe(10 * 60 + 30);
  });
});

describe("静默结束时刻", () => {
  it("从静默期内找到当天 08:00（本地）结束", () => {
    const end = nextQuietEnd(new Date("2026-09-18T15:00:00Z"), QUIET_22_8); // 本地 23:00
    expect(localMinutesAt(end, "Asia/Shanghai")).toBe(8 * 60);
    expect(end.toISOString()).toBe("2026-09-19T00:00:00.000Z");
    expect(end.getTime()).toBeGreaterThan(Date.parse("2026-09-18T15:00:00Z"));
  });

  it("从静默期外（傍晚）找到次日 08:00", () => {
    const end = nextQuietEnd(new Date("2026-09-18T10:00:00Z"), QUIET_22_8); // 本地 18:00
    expect(end.toISOString()).toBe("2026-09-19T00:00:00.000Z");
  });
});

describe("投递计划 planDelivery", () => {
  it("high 在静默期也立即投递", () => {
    const plan = planDelivery({
      type: "appeal_result",
      now: new Date("2026-09-18T15:00:00Z"),
      channelPrefs: PREFS,
      quiet: QUIET_22_8,
    });
    expect(plan.deliverAt).toBeNull();
    expect(plan.email).toBe(true);
    expect(plan.webpush).toBe(true);
    expect(plan.digest).toBe(false);
  });

  it("normal 在静默期延后到静默结束", () => {
    const now = new Date("2026-09-18T15:00:00Z");
    const plan = planDelivery({ type: "comment_reply", now, channelPrefs: PREFS, quiet: QUIET_22_8 });
    expect(plan.deliverAt?.toISOString()).toBe("2026-09-19T00:00:00.000Z");
    expect(plan.email).toBe(false); // 延后期间不立即发
    expect(plan.webpush).toBe(false);
    expect(plan.digest).toBe(false);
  });

  it("normal 在非静默期立即投递", () => {
    const plan = planDelivery({
      type: "comment_reply",
      now: new Date("2026-09-18T04:00:00Z"),
      channelPrefs: PREFS,
      quiet: QUIET_22_8,
    });
    expect(plan.deliverAt).toBeNull();
    expect(plan.email).toBe(true);
  });

  it("low 不单独走外部通道，开启通道时聚合摘要到静默结束", () => {
    const plan = planDelivery({
      type: "spot_stale",
      now: new Date("2026-09-18T15:00:00Z"),
      channelPrefs: PREFS,
      quiet: QUIET_22_8,
    });
    expect(plan.email).toBe(false);
    expect(plan.webpush).toBe(false);
    expect(plan.digest).toBe(true);
    expect(plan.deliverAt?.toISOString()).toBe("2026-09-19T00:00:00.000Z");
  });

  it("low 在未开启静默时安排到下一个本地 09:00", () => {
    // 本地 18:00（UTC 10:00）→ 次日本地 09:00（UTC 01:00）
    const plan = planDelivery({
      type: "spot_stale",
      now: new Date("2026-09-18T10:00:00Z"),
      channelPrefs: PREFS,
      quiet: QUIET_OFF,
    });
    expect(plan.digest).toBe(true);
    expect(plan.deliverAt?.toISOString()).toBe("2026-09-19T01:00:00.000Z");
    expect(localMinutesAt(plan.deliverAt!, "Asia/Shanghai")).toBe(9 * 60);
  });

  it("用户关闭的通道不出现在计划里", () => {
    const plan = planDelivery({
      type: "review_approved",
      now: new Date("2026-09-18T04:00:00Z"),
      channelPrefs: { inapp: true, email: false, webpush: false },
      quiet: QUIET_OFF,
    });
    expect(plan.email).toBe(false);
    expect(plan.webpush).toBe(false);
  });

  it("关闭站内信时不写入通知中心，但外部通道照常", () => {
    const plan = planDelivery({
      type: "appeal_result",
      now: new Date("2026-09-18T15:00:00Z"),
      channelPrefs: { inapp: false, email: true, webpush: false },
      quiet: QUIET_22_8,
    });
    expect(plan.inapp).toBe(false);
    expect(plan.email).toBe(true);
  });

  it("低级别且所有外部通道都关闭时不做摘要（deliverAt 仍保留也不发外部）", () => {
    const plan = planDelivery({
      type: "spot_stale",
      now: new Date("2026-09-18T10:00:00Z"),
      channelPrefs: { inapp: true, email: false, webpush: false },
      quiet: QUIET_OFF,
    });
    // 没有任何外部通道要走，就不必安排摘要投递
    expect(plan.digest).toBe(false);
    expect(plan.deliverAt).toBeNull();
  });
});

describe("摘要时刻（显式）", () => {
  it("开启静默时摘要时刻等于静默结束", () => {
    const t = nextDigestTime(new Date("2026-09-18T15:00:00Z"), QUIET_22_8);
    expect(t.toISOString()).toBe("2026-09-19T00:00:00.000Z");
  });
});
