/**
 * 用户可选时区白名单。
 *
 * 不直接放开任意 IANA 字符串是为了让设置接口的校验是确定性的，
 * 同时也避免把 ICU 的几百个时区名直接丢给用户选。
 * 新增中文用户常用的海外时区时往这里加即可，不影响已存数据。
 */
export const supportedTimezones = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Manila",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
] as const;

export type SupportedTimezone = (typeof supportedTimezones)[number];

export function isSupportedTimezone(value: string): value is SupportedTimezone {
  return (supportedTimezones as readonly string[]).includes(value);
}
