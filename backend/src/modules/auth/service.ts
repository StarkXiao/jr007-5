import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { env, isProd } from "../../config/env";
import { ERROR_CODES } from "../../config/constants";
import { prisma } from "../../db/prisma";
import { redis } from "../../db/redis";
import { AppError } from "../../utils/errors";
import { randomToken, sha256 } from "../../utils/crypto";
import { signAccessToken } from "../../middleware/auth";
import { verifyCaptcha } from "../../services/captcha";
import { notify } from "../../services/notify";
import { logger } from "../../utils/logger";
import type { ChangePasswordInput, LoginInput, RegisterInput } from "./schemas";

export const REFRESH_COOKIE = "psdm_rt";
export const MAX_ACTIVE_REFRESH_TOKENS = 5;
// 轮换产生的撤销允许 30 秒重用宽限期。
// 多标签页同时刷新时，后到的那个标签页不会因为令牌刚被轮换就被踢下线。
const ROTATION_GRACE_MS = 30_000;
const CAPTCHA_AFTER_FAILURES = 5;
const LOCK_AFTER_FAILURES = 10;
const LOCK_SECONDS = 15 * 60;
const FAILURE_WINDOW_SECONDS = 15 * 60;

function refreshCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeMs,
  };
}

function accountKey(account: string): string {
  return sha256(account.trim().toLowerCase()).slice(0, 32);
}

async function safeRedis<T>(action: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "登录保护组件不可用，已降级");
    return fallback;
  }
}

export async function failureCount(account: string): Promise<number> {
  return safeRedis(async () => Number((await redis.get(`loginfail:${accountKey(account)}`)) ?? 0), 0);
}

export async function isLocked(account: string): Promise<boolean> {
  return safeRedis(async () => (await redis.exists(`loginlock:${accountKey(account)}`)) === 1, false);
}

async function recordFailure(account: string): Promise<number> {
  return safeRedis(async () => {
    const key = `loginfail:${accountKey(account)}`;
    const count = await redis.incr(key);
    await redis.expire(key, FAILURE_WINDOW_SECONDS);
    if (count >= LOCK_AFTER_FAILURES) {
      await redis.set(`loginlock:${accountKey(account)}`, "1", "EX", LOCK_SECONDS);
    }
    return count;
  }, 0);
}

async function clearFailures(account: string): Promise<void> {
  await safeRedis(async () => {
    await redis.del(`loginfail:${accountKey(account)}`);
    await redis.del(`loginlock:${accountKey(account)}`);
  }, undefined);
}

/** 是否需要展示图形验证码 */
export async function captchaRequired(account: string): Promise<boolean> {
  return (await failureCount(account)) >= CAPTCHA_AFTER_FAILURES;
}

function normalizeAccount(account: string): { email?: string; phone?: string } {
  const value = account.trim();
  if (value.includes("@")) return { email: value.toLowerCase() };
  return { phone: value };
}

export async function registerUser(input: RegisterInput) {
  const email = input.email?.toLowerCase();
  const phone = input.phone;

  const existing = await prisma.user.findFirst({
    where: {
      OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])],
    },
    select: { id: true },
  });

  if (existing) {
    throw AppError.conflict(ERROR_CODES.VALIDATION_FAILED, "该邮箱或手机号已被注册");
  }

  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);

  return prisma.user.create({
    data: {
      email: email ?? null,
      phone: phone ?? null,
      passwordHash,
      nickname: input.nickname,
      role: "user",
      status: "active",
      settings: { create: {} },
    },
    select: { uuid: true, nickname: true, role: true, creditScore: true },
  });
}

async function issueRefreshToken(userId: bigint, req: Request): Promise<string> {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TTL * 1000);

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
      ip: (req.ip ?? req.socket.remoteAddress)?.trim() || null,
      expiresAt,
    },
  });

  // 只保留最近 N 个有效会话，超出的按创建时间淘汰
  const active = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (active.length > MAX_ACTIVE_REFRESH_TOKENS) {
    await prisma.refreshToken.updateMany({
      where: { id: { in: active.slice(MAX_ACTIVE_REFRESH_TOKENS).map((item) => item.id) } },
      data: { revokedAt: new Date(), revokedReason: "evicted" },
    });
  }

  return token;
}

export async function loginUser(input: LoginInput, req: Request, res: Response) {
  const account = input.account.trim();

  if (await isLocked(account)) {
    throw new AppError(
      429,
      ERROR_CODES.RATE_LIMITED,
      "登录失败次数过多，账号已被临时锁定，请 15 分钟后再试",
    );
  }

  if (await captchaRequired(account)) {
    const passed = await verifyCaptcha(input.captchaId ?? "", input.captchaCode ?? "");
    if (!passed) {
      throw AppError.badRequest("图形验证码不正确或已过期");
    }
  }

  const user = await prisma.user.findFirst({
    where: normalizeAccount(account),
    select: {
      id: true,
      uuid: true,
      passwordHash: true,
      nickname: true,
      role: true,
      status: true,
      creditScore: true,
      banReason: true,
      deletedAt: true,
    },
  });

  // 账号不存在与密码错误返回同一文案，避免账号枚举
  const passwordOk = user ? await bcrypt.compare(input.password, user.passwordHash) : false;

  if (!user || !passwordOk || user.deletedAt) {
    await recordFailure(account);
    throw new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, "账号或密码不正确");
  }

  if (user.status === "banned") {
    throw new AppError(
      403,
      ERROR_CODES.ACCOUNT_BANNED,
      `账号已被封禁${user.banReason ? `：${user.banReason}` : ""}。如有疑问可通过申诉渠道联系管理员。`,
    );
  }

  await clearFailures(account);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id, req);
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(env.REFRESH_TTL * 1000));

  return {
    accessToken,
    expiresIn: env.JWT_ACCESS_TTL,
    user: {
      uuid: user.uuid,
      nickname: user.nickname,
      role: user.role,
      creditScore: user.creditScore,
    },
  };
}

/** 刷新时轮换令牌（旧令牌立即失效），降低令牌被窃取的危害 */
export async function refreshSession(req: Request, res: Response) {
  const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? undefined;
  if (!token) throw AppError.unauthorized("登录状态已失效，请重新登录");

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      user: {
        select: {
          id: true,
          uuid: true,
          role: true,
          status: true,
          nickname: true,
          creditScore: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!record || record.expiresAt < new Date() || record.user.deletedAt) {
    res.clearCookie(REFRESH_COOKIE, { path: "/" });
    throw AppError.unauthorized("登录状态已失效，请重新登录");
  }

  // 只有"因为轮换而被撤销"的令牌才允许在宽限期内重用；
  // 登出、封禁、改密导致的撤销必须立即失效。
  const withinRotationGrace =
    record.revokedAt !== null &&
    record.revokedReason === "rotated" &&
    Date.now() - record.revokedAt.getTime() < ROTATION_GRACE_MS;

  if (record.revokedAt && !withinRotationGrace) {
    res.clearCookie(REFRESH_COOKIE, { path: "/" });
    throw AppError.unauthorized("登录状态已失效，请重新登录");
  }

  if (record.user.status === "banned") {
    res.clearCookie(REFRESH_COOKIE, { path: "/" });
    throw new AppError(403, ERROR_CODES.ACCOUNT_BANNED, "账号已被封禁");
  }

  if (!record.revokedAt) {
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), revokedReason: "rotated" },
    });
  }

  const accessToken = signAccessToken(record.user);
  const nextRefresh = await issueRefreshToken(record.user.id, req);
  res.cookie(REFRESH_COOKIE, nextRefresh, refreshCookieOptions(env.REFRESH_TTL * 1000));

  return {
    accessToken,
    expiresIn: env.JWT_ACCESS_TTL,
    user: {
      uuid: record.user.uuid,
      nickname: record.user.nickname,
      role: record.user.role,
      creditScore: record.user.creditScore,
    },
  };
}

export async function logoutUser(req: Request, res: Response): Promise<void> {
  const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? undefined;
  if (token) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "logout" },
    });
  }
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
}

export async function changePassword(
  userId: bigint,
  input: ChangePasswordInput,
  req: Request,
  res: Response,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user) throw AppError.notFound("用户不存在");

  const ok = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!ok) throw AppError.badRequest("当前密码不正确");

  const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_ROUNDS);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // 改密后踢掉其他所有会话，只保留当前这一个
  const current = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? "";
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null, tokenHash: { not: sha256(current) } },
    data: { revokedAt: new Date(), revokedReason: "password_changed" },
  });

  logger.info({ userId: userId.toString() }, "用户修改密码，其他会话已失效");

  // 安全类事件按紧急级别通知：三通道齐发且不受静默时段限制。
  // 用户本人改密时它是确认回执；若账号被盗，这是受害者唯一能立刻察觉的渠道。
  await notify({
    userId,
    type: "security_alert",
    title: "你的登录密码已修改",
    body: "如果这不是你本人的操作，请尽快通过找回密码功能重置并检查账号活动。",
    payload: { event: "password_changed" },
  });
}
