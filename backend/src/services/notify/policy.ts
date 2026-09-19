import {
  NOTIFICATION_LEVELS,
  type NotificationLevel,
  type NotifyChannel,
} from "../../config/constants";
import type { NotificationPolicyInput, QuietHoursSettings } from "./types";

/** 级别数字序，越大越紧急（与枚举数组顺序对应） */
const LEVEL_RANK: Record<NotificationLevel, number> = Object.fromEntries(
  [...NOTIFICATION_LEVELS].reverse().map((level, index) => [level, index]),
) as Record<NotificationLevel, number>;

export function levelAtLeast(level: NotificationLevel, threshold: NotificationLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}

/** HH:MM 解析为当日分钟数；非法格式返回 null */
export function parseHHMM(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 校验 IANA 时区名（如 Asia/Shanghai），非法时回退 UTC，避免直接抛错打断调用方 */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * 取某个 UTC 时刻在用户时区下的"当日分钟数"。
 * 用 en-CA 的 en-US 格式取 24 小时制字段，避免 toLocaleTimeString 的 AM/PM 歧义。
 */
export function localMinuteOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTimeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  // 极少数环境午夜返回 "24"，归一化为 0
  return (hour % 24) * 60 + minute;
}

/**
 * 判断给定 UTC 时刻是否落在静默窗口内。
 * 窗口为本地时区 [start, end)；支持跨午夜（如 22:00–08:00）；start=end 视为全天静默。
 */
export function isInQuietHours(
  at: Date,
  settings: QuietHoursSettings,
): boolean {
  const start = parseHHMM(settings.quietHoursStart);
  const end = parseHHMM(settings.quietHoursEnd);
  if (start === null || end === null) return false;

  const now = localMinuteOfDay(at, settings.timeZone);

  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  // 跨午夜：[22:00, 24:00) ∪ [00:00, 08:00)
  return now >= start || now < end;
}

/**
 * 计算静默窗口的下一个结束时刻（UTC）。
 * 用"向后最多探测 3 天本地日期"的朴素办法处理 DST：
 * 每次以 UTC 24h 步进，取探测当天本地 end 对应的 UTC 时刻，
 * 第一个严格晚于 now 的就是答案，DST 导致的 23/25 小时偏移被自然吸收。
 */
export function nextQuietHoursEnd(
  from: Date,
  settings: QuietHoursSettings,
): Date {
  const endMinute = parseHHMM(settings.quietHoursEnd);
  if (endMinute === null) return new Date(from.getTime() + 3600000);

  const timeZone = safeTimeZone(settings.timeZone);

  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const probeUtcDay = new Date(from.getTime() + dayOffset * 86400000);

    // 探测日 UTC 00:00 对应的用户本地日历日
    const localDateParts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(probeUtcDay);
    const year = Number(localDateParts.find((p) => p.type === "year")?.value);
    const month = Number(localDateParts.find((p) => p.type === "month")?.value);
    const day = Number(localDateParts.find((p) => p.type === "day")?.value);

    // 本地日历日的 end 时刻在该时区墙上的表示，转 UTC：
    // 取本地当天 00:00 的时间戳，再加上 end 分钟数，
    // 最后用格式化差值把"墙上时刻"翻译成 UTC 毫秒。
    const wallMidnightUtcGuess = Date.UTC(year, month - 1, day);
    const wallEndUtcGuess = wallMidnightUtcGuess + endMinute * 60000;

    const endUtc = resolveWallTimeUtc(new Date(wallEndUtcGuess), endMinute, timeZone);

    if (endUtc.getTime() > from.getTime()) return endUtc;
  }

  // 理论上不会走到这里；兜底 1 小时后补发，避免通知被无限期挂起
  return new Date(from.getTime() + 3600000);
}

/**
 * 给定一个"按 UTC 猜测的本地墙上时刻"，修正时区偏移得到真正的 UTC 时刻。
 * Intl 无法直接把墙上时刻解释为 UTC，因此用一次往返：
 * 读出猜测时刻在目标时区的本地分钟数，与期望分钟数求差并平移，再迭代一次消除 DST 跳变。
 */
function resolveWallTimeUtc(guessUtc: Date, expectedMinuteOfDay: number, timeZone: string): Date {
  let candidate = guessUtc;

  for (let i = 0; i < 3; i += 1) {
    const local = localMinuteOfDay(candidate, timeZone);
    const driftMinutes = (local - expectedMinuteOfDay + 1440) % 1440;
    if (driftMinutes === 0) return candidate;
    candidate = new Date(candidate.getTime() - driftMinutes * 60000);
  }

  return candidate;
}

export interface ChannelDecision {
  channel: NotifyChannel;
  /** sent=立即投递；deferred=静默时段暂缓；skipped=开关关闭或级别未达阈值 */
  action: "sent" | "deferred" | "skipped";
  reason: string;
}

export interface NotifyPlan {
  level: NotificationLevel;
  channels: Record<NotifyChannel, ChannelDecision>;
  /** 暂缓通道统一在此时刻后补发（取同一窗口，简化巡检） */
  deferredUntil: Date | null;
}

/**
 * 三通道分级发送的核心决策（纯函数，便于单测）：
 *
 * 1. 站内信永远 sent——它是必达凭证，不分级、不受开关与静默影响。
 * 2. 邮件/推送先过用户总开关，再过"最低接收级别"阈值。
 * 3. 命中静默时段时：critical 仍然立即发；其余级别 deferred，等静默结束补发。
 */
export function planNotification(input: NotificationPolicyInput, now: Date = new Date()): NotifyPlan {
  const { level, settings } = input;
  const inQuiet = settings.quietHoursEnabled && isInQuietHours(now, settings);

  const decide = (
    channel: Exclude<NotifyChannel, "inapp">,
    enabled: boolean,
    minLevel: NotificationLevel,
  ): ChannelDecision => {
    if (!enabled) return { channel, action: "skipped", reason: "channel_disabled" };
    if (!levelAtLeast(level, minLevel)) return { channel, action: "skipped", reason: "below_min_level" };
    if (inQuiet && level !== "critical") {
      return { channel, action: "deferred", reason: "quiet_hours" };
    }
    return { channel, action: "sent", reason: "eligible" };
  };

  const email = decide("email", settings.notifyEmail, settings.emailMinLevel);
  const push = decide(
    "push",
    settings.notifyPush,
    settings.pushMinLevel,
  );

  const hasDeferred = email.action === "deferred" || push.action === "deferred";
  const deferredUntil = hasDeferred ? nextQuietHoursEnd(now, settings) : null;

  return {
    level,
    channels: {
      inapp: { channel: "inapp", action: "sent", reason: "always_delivered" },
      email,
      push,
    },
    deferredUntil,
  };
}
