<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import type { Paged, Spot, NotificationLevel, NotificationSettings } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import { disablePush, enablePush, getPushAvailability } from "@/services/push";

const auth = useAuthStore();
const catalog = useCatalogStore();
const router = useRouter();

const tab = ref("contributions");
const spots = ref<Spot[]>([]);
const favorites = ref<Spot[]>([]);
const statusFilter = ref<string>("");
const loading = ref(false);

const DEFAULT_SETTINGS: NotificationSettings = {
  defaultFuzzRadius: 50,
  notifyEmail: true,
  notifyInapp: true,
  notifyPush: false,
  emailMinLevel: "important",
  pushMinLevel: "normal",
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  timeZone: "Asia/Shanghai",
  locale: "zh-CN",
};

const settings = ref<NotificationSettings>({ ...DEFAULT_SETTINGS });
const passwordForm = ref({ currentPassword: "", newPassword: "" });

// 浏览器推送可用性：不支持的浏览器 / 服务端未配 VAPID 时，开关不可点
const pushSupported = ref(true);
const pushConfigured = ref(false);
const pushBusy = ref(false);

const LEVEL_OPTIONS: Array<{ value: NotificationLevel; label: string; hint: string }> = [
  { value: "critical", label: "仅紧急", hint: "安全提醒、隐私风险" },
  { value: "important", label: "重要以上", hint: "含审核结果、申诉与处置" },
  { value: "normal", label: "普通以上", hint: "含被回复、审核通过" },
  { value: "info", label: "全部提醒", hint: "含所有系统通知" },
];

const TIMEZONE_OPTIONS = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC",
];

/** 展示某时区相对 UTC 的当前偏移（DST 期间会自然变化） */
function timezoneOffsetLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    // name 形如 GMT+8 / GMT-5 / GMT，归一化成 +08:00 风格成本高，直接展示原文
    return name.replace("GMT", "").replace(/^([+-])(\d)$/, "$10$2:00") || "+00:00";
  } catch {
    return "";
  }
}

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending: "待审核",
  in_review: "审核中",
  auto_rejected: "自动预检未通过",
  changes_requested: "需要修改",
  published: "已发布",
  rejected: "未通过",
  appealing: "申诉中",
  rejected_final: "终审未通过",
  hidden: "已下架",
  archived: "已归档",
};

function statusTagType(status: string): "success" | "warning" | "danger" | "info" {
  if (status === "published") return "success";
  if (["rejected", "rejected_final", "hidden"].includes(status)) return "danger";
  if (["pending", "in_review", "appealing"].includes(status)) return "warning";
  return "info";
}

async function loadContributions() {
  loading.value = true;
  try {
    const result = await api.get<Paged<Spot>>("/me/spots", {
      status: statusFilter.value || undefined,
      pageSize: 50,
    });
    spots.value = result.items;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

async function loadFavorites() {
  const result = await api.get<Paged<Spot>>("/me/favorites", { pageSize: 50 });
  favorites.value = result.items;
}

async function loadSettings() {
  const result = await api.get<{
    settings: NotificationSettings;
    push?: { configured: boolean; vapidPublicKey: string };
  }>("/me/settings");
  settings.value = { ...DEFAULT_SETTINGS, ...result.settings };
  if (result.push) pushConfigured.value = result.push.configured;

  const availability = await getPushAvailability();
  pushSupported.value = availability.supported;
  pushConfigured.value = availability.configured;
}

async function saveSettings() {
  try {
    const { defaultFuzzRadius, notifyEmail, notifyInapp, notifyPush, emailMinLevel, pushMinLevel,
      quietHoursEnabled, quietHoursStart, quietHoursEnd, timeZone, locale } = settings.value;
    const result = await api.patch<{ settings: NotificationSettings }>("/me/settings", {
      defaultFuzzRadius, notifyEmail, notifyInapp, notifyPush, emailMinLevel, pushMinLevel,
      quietHoursEnabled, quietHoursStart, quietHoursEnd, timeZone, locale,
    });
    settings.value = { ...DEFAULT_SETTINGS, ...result.settings };
    ElMessage.success("设置已保存");
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function togglePush(nextEnabled: boolean) {
  pushBusy.value = true;
  try {
    if (nextEnabled) {
      await enablePush();
      settings.value.notifyPush = true;
      ElMessage.success("浏览器推送已开启");
    } else {
      await disablePush();
      settings.value.notifyPush = false;
      ElMessage.success("浏览器推送已关闭");
    }
  } catch (error) {
    // 订阅失败（权限拒绝等）时把开关弹回去，并只保存其它已改设置
    settings.value.notifyPush = !nextEnabled;
    ElMessage.error((error as Error).message);
  } finally {
    pushBusy.value = false;
  }
}

async function withdraw(uuid: string) {
  try {
    await ElMessageBox.confirm("撤回后这条记录会回到草稿状态，确定撤回吗？", "撤回提交", {
      confirmButtonText: "撤回",
      cancelButtonText: "取消",
    });
    await api.post(`/spots/${uuid}/withdraw`);
    ElMessage.success("已撤回，可以继续编辑");
    await loadContributions();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function appeal(uuid: string) {
  try {
    const { value } = await ElMessageBox.prompt("请说明申诉理由（至少 10 个字）", "提出申诉", {
      inputValidator: (text) => (text && text.trim().length >= 10 ? true : "请至少写 10 个字"),
    });
    await api.post(`/spots/${uuid}/appeal`, { reason: value.trim() });
    ElMessage.success("申诉已提交，管理员会终审");
    await loadContributions();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

async function requestManualReview(uuid: string) {
  try {
    await api.post(`/spots/${uuid}/request-manual-review`);
    ElMessage.success("已转人工复核");
    await loadContributions();
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function changePassword() {
  if (!passwordForm.value.currentPassword || !passwordForm.value.newPassword) {
    ElMessage.warning("请填写完整");
    return;
  }
  try {
    await api.patch("/auth/password", passwordForm.value);
    ElMessage.success("密码已更新，其他设备的登录已失效");
    passwordForm.value = { currentPassword: "", newPassword: "" };
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function deleteAccount() {
  try {
    await ElMessageBox.confirm(
      "注销后你的昵称会变为「已注销用户」，已发布的记录会匿名保留在地图上。这个操作不可撤销。",
      "注销账号",
      { confirmButtonText: "确认注销", cancelButtonText: "再想想", type: "warning" },
    );
    const message = await auth.deleteAccount();
    ElMessage.success(message);
    void router.push({ name: "map" });
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

onMounted(async () => {
  await catalog.load().catch(() => undefined);
  await Promise.all([loadContributions(), loadFavorites(), loadSettings()]);
});
</script>

<template>
  <div class="page">
    <h1 class="page-title">我的空间</h1>

    <el-tabs v-model="tab">
      <el-tab-pane label="我的记录" name="contributions">
        <div style="display: flex; gap: 10px; margin-bottom: 12px; align-items: center">
          <el-select v-model="statusFilter" placeholder="全部状态" clearable style="width: 180px" @change="loadContributions">
            <el-option v-for="(label, value) in STATUS_LABEL" :key="value" :label="label" :value="value" />
          </el-select>
          <el-button type="primary" @click="router.push({ name: 'spot-new' })">记录新细节</el-button>
          <span class="muted">
            信用分 {{ auth.user?.creditScore }} · 已通过 {{ auth.user?.approvedCount }} 条
          </span>
        </div>

        <div v-loading="loading">
          <el-empty v-if="!loading && spots.length === 0" description="还没有记录，去地图上添加第一个吧" />

          <el-card v-for="spot in spots" :key="spot.uuid" shadow="never" style="margin-bottom: 10px">
            <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap">
              <div>
                <el-tag :type="statusTagType(spot.status)" size="small">
                  {{ STATUS_LABEL[spot.status] ?? spot.status }}
                </el-tag>
                <span style="margin-left: 8px; font-weight: 600">{{ spot.title }}</span>
                <div class="muted" style="margin-top: 4px">
                  {{ spot.category.name }} ·
                  {{ new Date(spot.createdAt).toLocaleDateString("zh-CN") }}
                </div>
              </div>

              <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start">
                <el-button size="small" @click="router.push({ name: 'spot-detail', params: { uuid: spot.uuid } })">
                  查看
                </el-button>
                <el-button
                  v-if="['draft', 'changes_requested', 'auto_rejected', 'rejected'].includes(spot.status)"
                  size="small"
                  @click="router.push({ name: 'spot-edit', params: { uuid: spot.uuid } })"
                >
                  继续编辑
                </el-button>
                <el-button v-if="['pending', 'in_review'].includes(spot.status)" size="small" @click="withdraw(spot.uuid)">
                  撤回
                </el-button>
                <el-button v-if="spot.status === 'auto_rejected'" size="small" @click="requestManualReview(spot.uuid)">
                  转人工复核
                </el-button>
                <el-button v-if="spot.status === 'rejected'" size="small" type="warning" @click="appeal(spot.uuid)">
                  申诉
                </el-button>
              </div>
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <el-tab-pane label="我的收藏" name="favorites">
        <el-empty v-if="favorites.length === 0" description="还没有收藏任何地点" />
        <el-card v-for="spot in favorites" :key="spot.uuid" shadow="never" style="margin-bottom: 10px">
          <div style="display: flex; justify-content: space-between; gap: 12px">
            <div>
              <span class="category-chip" :style="{ background: spot.category.color }">{{ spot.category.name }}</span>
              <span style="margin-left: 8px; font-weight: 600">{{ spot.title }}</span>
            </div>
            <el-button size="small" @click="router.push({ name: 'spot-detail', params: { uuid: spot.uuid } })">
              查看
            </el-button>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="账号设置" name="settings">
        <el-card shadow="never">
          <template #header>触达通道</template>
          <el-form label-position="top">
            <el-form-item label="默认位置模糊半径">
              <el-select v-model="settings.defaultFuzzRadius" style="width: 160px">
                <el-option label="20 米" :value="20" />
                <el-option label="50 米" :value="50" />
                <el-option label="100 米" :value="100" />
              </el-select>
            </el-form-item>

            <el-form-item label="站内信">
              <el-switch v-model="settings.notifyInapp" active-text="在通知中心接收全部通知" />
              <p class="muted" style="margin: 4px 0 0; font-size: 12px">
                站内信始终作为凭证保留，关闭后仅影响入口提示，不影响通知实际入库。
              </p>
            </el-form-item>

            <el-form-item label="邮件">
              <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
                <el-switch v-model="settings.notifyEmail" />
                <span class="muted">接收级别不低于</span>
                <el-select v-model="settings.emailMinLevel" style="width: 150px">
                  <el-option
                    v-for="option in LEVEL_OPTIONS"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  />
                </el-select>
              </div>
            </el-form-item>

            <el-form-item label="浏览器推送">
              <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
                <el-switch
                  :model-value="settings.notifyPush"
                  :disabled="!pushSupported || !pushConfigured || pushBusy"
                  @change="togglePush"
                />
                <span class="muted">接收级别不低于</span>
                <el-select v-model="settings.pushMinLevel" style="width: 150px">
                  <el-option
                    v-for="option in LEVEL_OPTIONS"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  />
                </el-select>
              </div>
              <p class="muted" style="margin: 4px 0 0; font-size: 12px">
                <template v-if="!pushSupported">当前浏览器不支持系统通知（需要 HTTPS 或 localhost 环境）。</template>
                <template v-else-if="!pushConfigured">站点尚未配置推送密钥，暂时无法开启。</template>
                <template v-else>开启时浏览器会请求系统通知权限；关闭页面后仍能收到紧急与重要通知。</template>
              </p>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>静默时段</template>
          <el-form label-position="top">
            <el-form-item>
              <el-switch
                v-model="settings.quietHoursEnabled"
                active-text="在以下时段暂缓邮件与浏览器推送"
              />
            </el-form-item>
            <el-form-item label="静默时间（按你所在时区的本地时间）">
              <el-time-picker
                v-model="settings.quietHoursStart"
                format="HH:mm"
                value-format="HH:mm"
                :disabled="!settings.quietHoursEnabled"
                placeholder="开始"
                style="width: 120px"
              />
              <span style="margin: 0 8px">至</span>
              <el-time-picker
                v-model="settings.quietHoursEnd"
                format="HH:mm"
                value-format="HH:mm"
                :disabled="!settings.quietHoursEnabled"
                placeholder="结束"
                style="width: 120px"
              />
              <span class="muted" style="margin-left: 12px">支持跨午夜，如 22:00 至次日 08:00</span>
            </el-form-item>
            <el-form-item label="所在时区">
              <el-select v-model="settings.timeZone" filterable style="width: 240px">
                <el-option
                  v-for="tz in TIMEZONE_OPTIONS"
                  :key="tz"
                  :label="`${tz}（UTC${timezoneOffsetLabel(tz)}）`"
                  :value="tz"
                />
              </el-select>
            </el-form-item>
            <p class="muted" style="font-size: 12px">
              静默时段内仅站内信照常写入；普通与重要通知暂缓，静默结束后邮件合并为一封摘要补发，浏览器推送逐条补发。
              <strong>紧急通知（如账号安全、隐私风险）不受静默限制。</strong>
            </p>
            <el-button type="primary" @click="saveSettings">保存设置</el-button>
          </el-form>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>修改密码</template>
          <el-form label-position="top">
            <el-form-item label="当前密码">
              <el-input v-model="passwordForm.currentPassword" type="password" show-password />
            </el-form-item>
            <el-form-item label="新密码">
              <el-input v-model="passwordForm.newPassword" type="password" show-password />
            </el-form-item>
            <el-button @click="changePassword">更新密码</el-button>
          </el-form>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>注销账号</template>
          <p class="muted">
            注销后昵称会变为「已注销用户」，已发布的记录会匿名保留在地图上，历史贡献不会消失，但不再关联你的身份。
          </p>
          <el-button type="danger" plain @click="deleteAccount">注销账号</el-button>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
