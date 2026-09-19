import type { NotificationLevel, NotificationType } from "../../config/constants";

/** 静默窗口所需设置（本地时区 HH:MM 闭开区间） */
export interface QuietHoursSettings {
  quietHoursStart: string;
  quietHoursEnd: string;
  timeZone: string;
}

/** 投递决策需要的用户设置子集（API 层保证缺省值已补齐） */
export interface NotificationPolicyInput {
  level: NotificationLevel;
  settings: {
    notifyEmail: boolean;
    notifyPush: boolean;
    emailMinLevel: NotificationLevel;
    pushMinLevel: NotificationLevel;
    quietHoursEnabled: boolean;
  } & QuietHoursSettings;
}

export interface NotifyInput {
  userId: bigint;
  type: NotificationType;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  /** 不显式指定时按类型映射取默认级别 */
  level?: NotificationLevel;
}

export interface NotifyJobData {
  notificationId: string;
}

export interface FlushJobData {
  task: "flush-deferred";
}
