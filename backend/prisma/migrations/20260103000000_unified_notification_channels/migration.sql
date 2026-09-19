-- 统一通知触达：站内信 / 邮件 / 浏览器推送，按重要程度分级 + 静默时段
-- 手工编写，与 schema.prisma 保持一致（参见 20260102 迁移中关于手工索引的警告）。

-- ============ 用户设置：推送开关、静默时段、时区 ============
ALTER TABLE "user_settings" ADD COLUMN "notify_push" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false;
-- 静默开始/结束时刻为用户时区下自午夜起的分钟数：默认 22:00 – 次日 08:00
ALTER TABLE "user_settings" ADD COLUMN "quiet_start" SMALLINT NOT NULL DEFAULT 1320;
ALTER TABLE "user_settings" ADD COLUMN "quiet_end" SMALLINT NOT NULL DEFAULT 480;
ALTER TABLE "user_settings" ADD COLUMN "timezone" VARCHAR(48) NOT NULL DEFAULT 'Asia/Shanghai';

-- ============ 通知：级别、推送状态、延迟投递、摘要聚合 ============
ALTER TABLE "notifications" ADD COLUMN "level" VARCHAR(8) NOT NULL DEFAULT 'normal';
ALTER TABLE "notifications" ADD COLUMN "channels" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "notifications" ADD COLUMN "push_sent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notifications" ADD COLUMN "inapp_hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notifications" ADD COLUMN "deliver_at" TIMESTAMPTZ(6);
ALTER TABLE "notifications" ADD COLUMN "digest_id" BIGINT;

-- worker 每 10 分钟扫描到期的延迟通知（静默消化 / 低级别摘要）
CREATE INDEX "idx_notify_deliver_at" ON "notifications"("deliver_at");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_digest_id_fkey"
  FOREIGN KEY ("digest_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============ 浏览器推送订阅（Web Push / VAPID） ============
CREATE TABLE "push_subscriptions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" VARCHAR(256),
    "last_error_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "idx_push_sub_user" ON "push_subscriptions"("user_id");

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
