/**
 * 通知分级与静默时段策略（纯函数，不碰数据库，方便单测）。
 *
 * 设计原则：
 * 1. 站内信是"账本"，事件发生就落库；但用户关掉站内信后不进通知中心/未读数。
 * 2. 外部通道（邮件、浏览器推送）受「通道开关 × 重要程度 × 静默时段」共同约束。
 * 3. 重要通知（账号处置、申诉结果）在静默时段也立即触达——静默不能耽误正事。
 * 4. 普通通知在静默时段延后到静默结束统一发。
 * 5. 低级别通知不单独打扰，攒到静默结束（或每天 09:00）聚合为一条摘要。
 */
import {
  NOTIFICATION_LEVEL_BY_TYPE,
  type NotificationLevel,
  type NotificationType,
} from "../../config/constants";

export type NotifyChannel = "inapp" | "email" | "webpush";

export interface QuietHoursSettings {
  enabled: boolean;
  /** 自午夜起的分钟数，0–1439 */
  startMin: number;
  endMin: number;
  /** IANA 时区名，例如 Asia/Shanghai */
  timezone: string;
}

/** 各重要程度默认启用的外部通道；站内信始终先落库，不在这里决定 */
export const CHANNELS_BY_LEVEL: Record<NotificationLevel, NotifyChannel[]> = {
  high: ["inapp", "email", "webpush"],
  normal: ["inapp", "email", "webpush"],
  low: ["inapp"],
};

/** 低级别通知在「未开启静默」时的摘要时刻：用户本地时间 09:00 */
export const LOW_DIGEST_DEFAULT_MIN = 9 * 60;

export function levelOf(type: NotificationType, override?: NotificationLevel): NotificationLevel {
  return override ?? NOTIFICATION_LEVEL_BY_TYPE[type] ?? "normal";
}

/** 某一级别是否允许走指定外部通道（还要再叠加用户的通道开关） */
export function levelAllowsChannel(level: NotificationLevel, channel: NotifyChannel): boolean {
  return CHANNELS_BY_LEVEL[level].includes(channel);
}

/**
 * 取某时刻在用户时区下的「自午夜起分钟数」。
 * 用 Intl 做时区换算，不引入额外依赖；夏令时由 ICU 负责。
 */
export function localMinutesAt(date: Date, timezone: string): number {
  let hh = 23;
  let mm = 59;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const hourPart = parts.find((p) => p.type === "hour");
    const minutePart = parts.find((p) => p.type === "minute");
    // 某些 ICU 在 24:00 附近会返回 "24"，归一回 0
    hh = Number(hourPart?.value ?? "23") % 24;
    mm = Number(minutePart?.value ?? "59");
  } catch {
    // 非法时区：退化为 UTC，绝不能因为用户填错时区就不发通知
    hh = date.getUTCHours();
    mm = date.getUTCMinutes();
  }
  return hh * 60 + mm;
}

/** 区间 [start, end) 是否包含 value（分钟数），区间允许跨过午夜 */
function withinRange(value: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return value >= start && value < end;
  // 跨午夜，例如 22:00–08:00
  return value >= start || value < end;
}

/** 判断给定时刻是否处于用户的静默时段 */
export function isInQuietHours(date: Date, settings: QuietHoursSettings): boolean {
  if (!settings.enabled) return false;
  return withinRange(
    localMinutesAt(date, settings.timezone),
    settings.startMin,
    settings.endMin,
  );
}

/**
 * 计算下一个静默时段结束的绝对时刻（UTC Date）。
 *
 * 做法：从当前分钟起逐分钟推进，找到"本地静默状态从 true 变 false"的第一分钟。
 * 逐分钟扫描看起来笨，但每次调用只发生在通知写入瞬间，且 48 小时内必然有解；
 * 好处是夏令时切换日（本地某小时不存在或出现两次）也天然算对，不用手工推导偏移。
 */
export function nextQuietEnd(now: Date, settings: QuietHoursSettings): Date {
  const step = 60_000;
  let cursor = new Date(Math.ceil(now.getTime() / step) * step);
  let wasQuiet = isInQuietHours(cursor, settings);
  const limit = now.getTime() + 48 * 3600_000;

  while (cursor.getTime() <= limit) {
    const quiet = isInQuietHours(cursor, settings);
    if (wasQuiet && !quiet) return cursor;
    wasQuiet = quiet;
    cursor = new Date(cursor.getTime() + step);
  }
  // 理论上到不了；兜底 8 小时后
  return new Date(now.getTime() + 8 * 3600_000);
}

/**
 * 低级别通知的摘要投递时刻：
 * - 开启静默：静默结束时刻；
 * - 未开启静默：用户本地下一个 09:00。
 */
export function nextDigestTime(now: Date, settings: QuietHoursSettings): Date {
  if (settings.enabled) {
    return nextQuietEnd(now, settings);
  }

  const step = 60_000;
  let cursor = new Date(Math.ceil(now.getTime() / step) * step);
  const limit = now.getTime() + 36 * 3600_000;
  while (cursor.getTime() <= limit) {
    if (localMinutesAt(cursor, settings.timezone) === LOW_DIGEST_DEFAULT_MIN && cursor > now) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + step);
  }
  return new Date(now.getTime() + 24 * 3600_000);
}

export interface DeliveryPlan {
  /** 是否写入通知中心（受用户站内信开关影响） */
  inapp: boolean;
  /** 是否立即尝试邮件 */
  email: boolean;
  /** 是否立即尝试浏览器推送 */
  webpush: boolean;
  /** 延迟/摘要投递时，最终需要走的外部通道（用于持久化与补发） */
  deferredChannels: { email: boolean; webpush: boolean };
  /** 外部通道的投递时刻；null 表示立即投递或不走外部通道 */
  deliverAt: Date | null;
  /** 是否以摘要形式聚合发送（低级别） */
  digest: boolean;
}

export interface PlanInput {
  type: NotificationType;
  level?: NotificationLevel;
  now?: Date;
  channelPrefs: { inapp: boolean; email: boolean; webpush: boolean };
  quiet: QuietHoursSettings;
}

/**
 * 汇总决定一条通知怎么发。这是全项目唯一的分级决策点，
 * worker 的延迟扫描和实时发送都必须以这里的结果为准。
 */
export function planDelivery(input: PlanInput): DeliveryPlan {
  const now = input.now ?? new Date();
  const level = levelOf(input.type, input.level);
  const quiet = isInQuietHours(now, input.quiet);

  const inapp = input.channelPrefs.inapp;
  // low 级别不"单独"走外部通道，但用户开了的通道会随摘要发送，因此这里的
  // 通道意图按用户开关取，由下面的 digest 分支决定发送形态
  const emailWanted =
    input.channelPrefs.email && (level === "low" || levelAllowsChannel(level, "email"));
  const pushWanted =
    input.channelPrefs.webpush && (level === "low" || levelAllowsChannel(level, "webpush"));
  const externalWanted = emailWanted || pushWanted;

  if (level === "low") {
    // 低级别不单独打扰：开启了外部通道才安排摘要，否则只留站内账本
    if (!externalWanted) {
      return {
        inapp,
        email: false,
        webpush: false,
        deferredChannels: { email: false, webpush: false },
        deliverAt: null,
        digest: false,
      };
    }
    return {
      inapp,
      email: false,
      webpush: false,
      deferredChannels: { email: emailWanted, webpush: pushWanted },
      deliverAt: nextDigestTime(now, input.quiet),
      digest: true,
    };
  }

  // high：静默也立即发；normal：静默期延后到静默结束（通道意图保留在 deferredChannels）
  if (level === "normal" && quiet) {
    return {
      inapp,
      email: false,
      webpush: false,
      deferredChannels: { email: emailWanted, webpush: pushWanted },
      deliverAt: nextQuietEnd(now, input.quiet),
      digest: false,
    };
  }

  return {
    inapp,
    email: emailWanted,
    webpush: pushWanted,
    deferredChannels: { email: false, webpush: false },
    deliverAt: null,
    digest: false,
  };
}
