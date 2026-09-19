-- 统一触达通道：站内信 / 邮件 / 浏览器推送 + 事件分级 + 静默时段
--
-- 手工编写（见 20260102000000 迁移的说明：不要直接套用 prisma migrate diff）。
-- notifications 原有 email_sent 布尔列升级为三个通道各自的投递状态机
-- （skipped/deferred/sent/failed），历史数据迁移规则：
--   email_sent=true  -> email_status='sent'
--   email_sent=false -> email_status='skipped'

CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'deferred', 'sent', 'skipped', 'failed');

-- ============ 用户设置：通道开关、分级阈值、静默时段 ============

ALTER TABLE "user_settings" ADD COLUMN "notify_push" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN "email_min_level" VARCHAR(16) NOT NULL DEFAULT 'important';
ALTER TABLE "user_settings" ADD COLUMN "push_min_level" VARCHAR(16) NOT NULL DEFAULT 'normal';
ALTER TABLE "user_settings" ADD COLUMN "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN "quiet_hours_start" CHAR(5) NOT NULL DEFAULT '22:00';
ALTER TABLE "user_settings" ADD COLUMN "quiet_hours_end" CHAR(5) NOT NULL DEFAULT '08:00';
ALTER TABLE "user_settings" ADD COLUMN "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai';

-- ============ 浏览器推送订阅 ============

CREATE TABLE "push_subscriptions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "endpoint" VARCHAR(1024) NOT NULL,
    "endpoint_hash" CHAR(64) NOT NULL,
    "p256dh" VARCHAR(255) NOT NULL,
    "auth" VARCHAR(255) NOT NULL,
    "user_agent" VARCHAR(300),
    "expired" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE UNIQUE INDEX "push_subscriptions_endpoint_hash_key" ON "push_subscriptions"("endpoint_hash");
CREATE INDEX "idx_push_sub_user" ON "push_subscriptions"("user_id");
CREATE INDEX "idx_push_sub_expired" ON "push_subscriptions"("expired");

ALTER TABLE "push_subscriptions"
ADD CONSTRAINT "push_subscriptions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============ 通知：级别与三通道投递状态 ============

ALTER TABLE "notifications" ADD COLUMN "level" VARCHAR(16) NOT NULL DEFAULT 'normal';
ALTER TABLE "notifications"
    ADD COLUMN "inapp_status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'skipped',
    ADD COLUMN "email_status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'skipped',
    ADD COLUMN "push_status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'skipped';
ALTER TABLE "notifications" ADD COLUMN "deferred_until" TIMESTAMPTZ(6);

-- 旧数据按当时的语义迁移：有记录即站内信已达；邮件已发出的标记 sent
UPDATE "notifications" SET "inapp_status" = 'sent';
UPDATE "notifications" SET "email_status" = 'sent' WHERE "email_sent" = true;

ALTER TABLE "notifications" DROP COLUMN "email_sent";

-- 历史通知的级别按类型回填，让通知中心的分级展示对旧数据也成立
UPDATE "notifications" SET "level" = 'important'
WHERE "type" IN ('review_rejected', 'review_changes', 'appeal_result', 'report_result', 'comment_hidden');
UPDATE "notifications" SET "level" = 'critical' WHERE "type" = 'security_alert';

CREATE INDEX "idx_notify_email_pending" ON "notifications"("email_status", "deferred_until");
CREATE INDEX "idx_notify_push_pending" ON "notifications"("push_status", "deferred_until");
