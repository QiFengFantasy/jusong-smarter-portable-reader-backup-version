import { useEffect, useId, useRef, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";

import {
  AGENT_DEFAULT_BASE_URL,
  AGENT_DEFAULT_MODEL,
  clearAgentConfig,
  fetchAgentConfig,
  updateAgentConfig,
  type AgentConfigStatus,
} from "../../lib/agent";
import { cn, getErrorMessage } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { CardResetButton, SettingsCardHeader, fieldLabelClass, hintClass } from "./SettingsSectionNav";

/**
 * AGENT 分类：兼容 OpenAI 接口的模型服务配置（baseUrl / 模型 / API Key）。
 *
 * 从旧 `SettingsContent` 原样迁入，逻辑不变：
 * - 密钥只写不读，界面永远不显示已保存的明文；
 * - 本卡重置把 baseUrl/模型恢复默认；已配置密钥时二次确认后一并清除。
 */
export function AgentSection() {
  const [status, setStatus] = useState<AgentConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [baseUrl, setBaseUrl] = useState(AGENT_DEFAULT_BASE_URL);
  const [model, setModel] = useState(AGENT_DEFAULT_MODEL);
  const [keyInput, setKeyInput] = useState("");
  // 密码框失焦即清空显示，但保存时要能读到用户刚输入的值（点击保存会先触发 blur），
  // 所以用一个只存在内存里的 ref 暂存；保存结束后立即清空，绝不回显。
  const pendingKeyRef = useRef("");
  /** 失焦后异步丢弃暂存：点「保存」时 blur 先于 click，save() 会在 setTimeout
   *  清掉暂存之前同步读到刚输入的值；单纯移开焦点则密钥随即从内存丢弃。 */
  const clearPendingKeyLater = () => {
    window.setTimeout(() => {
      pendingKeyRef.current = "";
    }, 0);
  };
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 卡片「重置」会清除已保存的密钥，所以需要二次确认；这里复用确认态。
  const [confirmReset, setConfirmReset] = useState(false);
  const baseUrlId = useId();
  const modelId = useId();
  const apiKeyId = useId();
  const apiKeyHintId = useId();

  const applyStatus = (next: AgentConfigStatus) => {
    setStatus(next);
    setBaseUrl(next.baseUrl || AGENT_DEFAULT_BASE_URL);
    setModel(next.model || AGENT_DEFAULT_MODEL);
    pendingKeyRef.current = "";
    setKeyInput("");
  };

  useEffect(() => {
    let alive = true;
    fetchAgentConfig()
      .then((next) => {
        if (alive) applyStatus(next);
      })
      .catch((reason: unknown) => {
        if (alive) setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // 只在挂载时读取一次配置状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重置需要二次确认；几秒不点自动退回普通按钮，避免误触。
  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(() => setConfirmReset(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmReset]);

  const configured = status?.configured === true;

  const save = async () => {
    if (saving || loading) return;
    setError(null);
    setNotice(null);
    const nextBaseUrl = baseUrl.trim();
    const nextModel = model.trim();
    if (!nextBaseUrl) {
      setError("请填写 baseUrl，例如 https://api.deepseek.com。");
      return;
    }
    if (!/^https?:\/\//i.test(nextBaseUrl)) {
      setError("baseUrl 需以 http:// 或 https:// 开头。");
      return;
    }
    if (!nextModel) {
      setError("请填写模型名，例如 deepseek-chat。");
      return;
    }
    const apiKey = pendingKeyRef.current.trim();
    setSaving(true);
    try {
      const next = await updateAgentConfig({
        baseUrl: nextBaseUrl,
        model: nextModel,
        ...(apiKey ? { apiKey } : {}),
      });
      applyStatus(next);
      setNotice(apiKey ? "已保存配置与新的 API Key。" : "已保存配置（API Key 未修改）。");
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      // 无论成败都不保留密钥输入，避免明文停留在界面上。
      pendingKeyRef.current = "";
      setKeyInput("");
      setSaving(false);
    }
  };

  /** 本卡重置：恢复默认 baseUrl/model；已配置密钥时先二次确认，确认后一并清除已保存的密钥。 */
  const resetCard = async () => {
    if (saving || loading) return;
    if (configured && !confirmReset) {
      setError(null);
      setNotice(null);
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setSaving(true);
    setError(null);
    setNotice(null);
    const hadKey = configured;
    try {
      // 先把 baseUrl/model 写回默认值，再按需清除已保存的密钥（两步都成功才提示完成）。
      const next = await updateAgentConfig({
        baseUrl: AGENT_DEFAULT_BASE_URL,
        model: AGENT_DEFAULT_MODEL,
      });
      applyStatus(next);
      if (hadKey) {
        const cleared = await clearAgentConfig();
        applyStatus(cleared);
      }
      setBaseUrl(AGENT_DEFAULT_BASE_URL);
      setModel(AGENT_DEFAULT_MODEL);
      pendingKeyRef.current = "";
      setKeyInput("");
      setNotice(
        hadKey
          ? "已恢复默认 baseUrl/模型，并清除已保存的 API Key。"
          : "已恢复默认 baseUrl 与模型。",
      );
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <SettingsCardHeader
          title="AGENT"
          description="配置兼容 OpenAI 接口的模型服务。API Key 只保存在本机用户库（appData）的配置文件中，不上传、不回传，界面上永远不显示已保存的密钥。"
          action={
            <CardResetButton
              label={confirmReset ? "确认重置？" : "重置"}
              danger={confirmReset}
              disabled={saving || loading}
              title={
                configured
                  ? "本卡重置：恢复默认 baseUrl/模型，并清除已保存的 API Key（点击后需再次确认）"
                  : "本卡重置：恢复默认 baseUrl 与模型（当前未配置密钥）"
              }
              onClick={() => void resetCard()}
            />
          }
        />
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
                configured
                  ? "border-emerald-700/30 bg-emerald-700/10 text-emerald-800"
                  : "border-border bg-muted/60 text-ink-soft",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  configured ? "bg-emerald-600" : "bg-ink-soft/50",
                )}
                aria-hidden="true"
              />
              {loading ? "正在读取配置…" : configured ? "API Key 已配置" : "未配置 API Key"}
            </span>
            <span className="text-[11px] text-ink-soft/70">密钥只写不读</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={baseUrlId} className={fieldLabelClass}>
                baseUrl
              </label>
              <Input
                id={baseUrlId}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://api.deepseek.com"
                disabled={saving || loading}
                className="mt-2"
              />
            </div>
            <div>
              <label htmlFor={modelId} className={fieldLabelClass}>
                模型
              </label>
              <Input
                id={modelId}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder="deepseek-chat"
                disabled={saving || loading}
                className="mt-2"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor={apiKeyId}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-ink"
            >
              <KeyRound className="h-3.5 w-3.5 text-ink-soft" aria-hidden="true" />
              API Key
            </label>
            <Input
              id={apiKeyId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={keyInput}
              aria-describedby={apiKeyHintId}
              placeholder={configured ? "已配置，如需更换请输入新密钥" : "输入 DeepSeek API Key"}
              disabled={saving || loading}
              onChange={(event) => {
                setKeyInput(event.target.value);
                pendingKeyRef.current = event.target.value;
              }}
              onBlur={() => {
                setKeyInput("");
                clearPendingKeyLater();
              }}
              className="mt-2"
            />
            <p id={apiKeyHintId} className={hintClass}>
              {configured
                ? "已配置：已保存的 API Key 不会回显。如需更换，在上方输入新密钥后保存；留空表示不修改。"
                : "留空表示不修改已保存的密钥；保存或失焦后输入框会清空，已保存的密钥不会回显。"}
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-cinnabar/25 bg-cinnabar/5 px-3 py-2 text-xs leading-6 text-cinnabar"
            >
              {error}
            </p>
          ) : null}
          {notice ? (
            <p
              role="status"
              className="rounded-md border border-emerald-700/25 bg-emerald-700/5 px-3 py-2 text-xs leading-6 text-emerald-800"
            >
              {notice}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => void save()} disabled={saving || loading}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              保存配置
            </Button>
            <span className="text-[11px] leading-5 text-ink-soft/70">
              右上「重置」会恢复默认 baseUrl/模型
              {configured ? "，并清除已保存的 API Key（需二次确认）" : ""}。
            </span>
          </div>
        </CardContent>
      </Card>

      <p className="rounded-md border border-dashed border-border/80 bg-paper/50 px-3 py-2 text-[11px] leading-5 text-ink-soft/75">
        AGENT 是可选增强：未配置时阅读器与知识库的全部本地功能不受影响；配置后对话在本机发起请求，密钥不会离开本机用户库。
      </p>
    </div>
  );
}
