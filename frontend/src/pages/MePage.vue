<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import type { Paged, Spot, UserSettings } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import { subscribePush, unsubscribePush, pushSupport } from "@/services/push";

const auth = useAuthStore();
const catalog = useCatalogStore();
const router = useRouter();

const tab = ref("contributions");
const spots = ref<Spot[]>([]);
const favorites = ref<Spot[]>([]);
const statusFilter = ref<string>("");
const loading = ref(false);
const savingSettings = ref(false);

// quietStart/quietEnd 在界面上是 HH:mm，保存时再换算为分钟数
const settings = ref<UserSettings & { quietStartText: string; quietEndText: string }>({
  defaultFuzzRadius: 50,
  notifyEmail: true,
  notifyInapp: true,
  notifyPush: false,
  quietHoursEnabled: false,
  quietStart: 1320,
  quietEnd: 480,
  quietStartText: "22:00",
  quietEndText: "08:00",
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
});
const pushAvailability = ref<"ready" | "unsupported" | "disabled">("ready");
const passwordForm = ref({ currentPassword: "", newPassword: "" });

const TIMEZONES: Array<string> = [
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
];

function minutesToText(min: number): string {
  const hh = String(Math.floor(min / 60)).padStart(2, "0");
  const mm = String(min % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function textToMinutes(text: string): number {
  const [hh, mm] = text.split(":").map(Number);
  return hh * 60 + mm;
}

/**
 * 静默时段语义（与后端 policy 一致）：
 * - 重要通知（驳回、申诉结果、评论被隐藏）：静默期也立即送达；
 * - 普通通知（审核通过/需修改、回复、举报结果）：攒到静默结束再发；
 * - 低级别提醒（条目过期）：合并为一条摘要，在静默结束或每天 09:00 发送。
 */

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
  const result = await api.get<{ settings: UserSettings }>("/me/settings");
  const s = result.settings;
  settings.value = {
    ...s,
    quietStartText: minutesToText(s.quietStart),
    quietEndText: minutesToText(s.quietEnd),
  };
}

async function saveSettings() {
  savingSettings.value = true;
  try {
    if (settings.value.quietHoursEnabled && settings.value.quietStartText === settings.value.quietEndText) {
      ElMessage.warning("静默开始与结束时间不能相同");
      return;
    }

    // 打开推送开关时必须先完成浏览器订阅（这里有用户点击手势，权限框才能弹出）；
    // 订阅失败则不保存开关，避免"界面显示开着但实际收不到"
    if (settings.value.notifyPush) {
      try {
        await subscribePush();
      } catch (error) {
        settings.value.notifyPush = false;
        ElMessage.error((error as Error).message);
        return;
      }
    } else {
      await unsubscribePush().catch(() => undefined);
    }

    const payload: Partial<UserSettings> = {
      defaultFuzzRadius: settings.value.defaultFuzzRadius,
      notifyEmail: settings.value.notifyEmail,
      notifyInapp: settings.value.notifyInapp,
      notifyPush: settings.value.notifyPush,
      quietHoursEnabled: settings.value.quietHoursEnabled,
      quietStart: textToMinutes(settings.value.quietStartText),
      quietEnd: textToMinutes(settings.value.quietEndText),
      timezone: settings.value.timezone,
    };
    await api.patch("/me/settings", payload);
    await auth.fetchMe();
    ElMessage.success("设置已保存");
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    savingSettings.value = false;
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
  pushSupport()
    .then((state) => {
      pushAvailability.value = state;
    })
    .catch(() => undefined);
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
          <el-form label-position="top">
            <el-form-item label="默认位置模糊半径">
              <el-select v-model="settings.defaultFuzzRadius" style="width: 160px">
                <el-option label="20 米" :value="20" />
                <el-option label="50 米" :value="50" />
                <el-option label="100 米" :value="100" />
              </el-select>
            </el-form-item>

            <el-form-item label="触达通道">
              <el-checkbox v-model="settings.notifyInapp">站内信（通知中心与铃铛角标）</el-checkbox>
              <el-checkbox v-model="settings.notifyEmail">邮件通知</el-checkbox>
              <el-checkbox
                v-model="settings.notifyPush"
                :disabled="pushAvailability !== 'ready'"
              >
                浏览器推送
              </el-checkbox>
              <p v-if="pushAvailability === 'unsupported'" class="muted" style="margin: 4px 0 0">
                当前浏览器不支持推送，或页面不在 HTTPS / localhost 环境下。
              </p>
              <p v-else-if="pushAvailability === 'disabled'" class="muted" style="margin: 4px 0 0">
                站点尚未配置推送密钥，该通道暂不可用。
              </p>
              <p class="muted" style="margin: 4px 0 0">
                保存时浏览器会询问通知权限；拒绝过需在浏览器站点设置中手动恢复。
              </p>
            </el-form-item>

            <el-form-item label="静默时段">
              <el-switch v-model="settings.quietHoursEnabled" active-text="开启" inline-prompt />
              <template v-if="settings.quietHoursEnabled">
                <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap">
                  <el-time-picker
                    v-model="settings.quietStartText"
                    format="HH:mm"
                    value-format="HH:mm"
                    :clearable="false"
                    placeholder="开始"
                    aria-label="静默开始时间"
                  />
                  <span class="muted">至次日</span>
                  <el-time-picker
                    v-model="settings.quietEndText"
                    format="HH:mm"
                    value-format="HH:mm"
                    :clearable="false"
                    placeholder="结束"
                    aria-label="静默结束时间"
                  />
                  <el-select v-model="settings.timezone" style="width: 190px" aria-label="时区">
                    <el-option v-for="tz in TIMEZONES" :key="tz" :label="tz" :value="tz" />
                  </el-select>
                </div>
              </template>
              <p class="muted" style="margin: 8px 0 0; max-width: 640px">
                静默时段内：<strong>重要通知</strong>（审核驳回、申诉结果、评论被隐藏）仍会立即送达；
                <strong>普通通知</strong>（审核通过、需要修改、收到回复、举报结果）延后到静默结束；
                <strong>提醒类通知</strong>（条目过期等）合并为一条摘要，在静默结束或每天 09:00 发送。
                站内信始终记录，可随时在通知中心查看。
              </p>
            </el-form-item>

            <el-button type="primary" :loading="savingSettings" @click="saveSettings">保存设置</el-button>
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
