import { useCallback, useEffect, useState } from 'react';
import { LuLoaderCircle, LuShieldCheck } from 'react-icons/lu';
import { t } from '@/i18n';
import { hasHostBridge } from '@/lib/host-bridge';
import {
  getSidecarSandboxPosture,
  type EgressPosture,
  type SidecarSandboxPosture,
} from '@/lib/local-api';

/**
 * SecuritySettingsPanel — W4-3 layer-1（sidecar 进程沙箱）态势的持久披露。
 *
 * sidecar 进程持有服务商 API 密钥并接收不可信工具输出。收容失败时主进程
 * 拒绝启动（不是裸跑），态势记在 supervisor / lastSpawnRefusal 上
 * （GET /api/v2/sidecar/sandbox-posture）。手动关闭（sandbox:false /
 * STEERABLE_SIDECAR_SANDBOX=0）中性展示；收容失败告知「无法收容、已拒绝启动」。
 * layer-3（每次命令的沙箱）披露在工具卡片，不在此重复。
 *
 * 数据自管理：挂载拉一次，走 local-backend REST，无专用 IPC channel。
 */

type PostureReason = SidecarSandboxPosture['reason'];

/** 收容失败、已拒绝启动（告警行首句）。 */
const REFUSED_REASON_TEXT: Partial<Record<PostureReason, string>> = {
  platform_unsupported: 'No process sandbox backend is available on this platform',
  seatbelt_missing: '/usr/bin/sandbox-exec not found',
  profile_failed: 'Failed to generate the sandbox configuration (Seatbelt profile)',
  wrap_failed: 'The Linux process sandbox (bwrap / Landlock) could not wrap the sidecar',
  helper_missing: 'win-spawn-helper.exe not found',
};

/** 手动关闭原因的中文说明（中性行，不告警）。 */
const OPT_OUT_REASON_TEXT: Partial<Record<PostureReason, string>> = {
  disabled_by_option: 'Turned off with sandbox: false',
  disabled_by_env: 'Turned off with STEERABLE_SIDECAR_SANDBOX=0',
};

function activeHeadline(backend: SidecarSandboxPosture['backend']): string {
  switch (backend) {
    case 'seatbelt':
      return t('Seatbelt · partial enforcement');
    case 'bwrap':
      return t('bwrap · partial enforcement');
    case 'landlock':
      return t('Landlock · partial enforcement');
    case 'windows-restricted-token':
      return t('Windows restricted token · partial enforcement');
    case 'none':
      return t('Not sandboxed');
  }
}

function activeBody(backend: SidecarSandboxPosture['backend']): string {
  switch (backend) {
    case 'seatbelt':
      return t(
        'The sidecar process runs under macOS Seatbelt: writes are limited to ~/.steerable and the temp directory. Outbound network to remote hosts can only be limited by port (Seatbelt does not recognize host names), so this is recorded as "partial" rather than "full".',
      );
    case 'bwrap':
      return t(
        'The sidecar process runs under bubblewrap: writes are limited to ~/.steerable and the temp directory. Outbound network stays open (the sidecar needs to reach the LLM), so this is recorded as "partial".',
      );
    case 'landlock':
      return t(
        'The sidecar process runs under Linux Landlock: writes are limited to ~/.steerable and the temp directory. Outbound network stays open (the sidecar needs to reach the LLM), so this is recorded as "partial".',
      );
    case 'windows-restricted-token':
      return t(
        'The sidecar process runs under a Windows restricted token + Job Object: writes are limited to ~/.steerable. The helper does not enforce network policy (no WFP), so this is recorded as "partial".',
      );
    case 'none':
      return '';
  }
}

/** 出网管控态势行（W-egress-posture）：退回分支此前只有主进程日志可见。 */
function EgressPostureRow({ egress }: { egress: EgressPosture }) {
  if (egress.mode === 'per-host-proxy') {
    return (
      <p className="text-[11px] text-agent-muted-foreground">
        {t(
          'Egress control: the per-host allowlist proxy is active. Requests outside the allowlist ask you to allow them one by one (valid for this session only).',
        )}
      </p>
    );
  }
  if (egress.mode === 'disabled') {
    return (
      <p className="text-[11px] text-agent-muted-foreground">
        {t('Egress control: off{reason}.', { reason: egress.reason ? ` — ${egress.reason}` : '' })}
      </p>
    );
  }
  return (
    <p className="text-[11px] text-amber-600 dark:text-amber-400">
      {t('Egress control: fell back to port level (coarser control){reason}.', {
        reason: egress.reason ? ` — ${egress.reason}` : '',
      })}
    </p>
  );
}

export function SecuritySettingsPanel() {
  const [posture, setPosture] = useState<SidecarSandboxPosture | null>(null);
  const [egress, setEgress] = useState<EgressPosture | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const fetchPosture = useCallback(async () => {
    if (!hasHostBridge()) return;
    setLoading(true);
    setUnavailable(null);
    try {
      const res = await getSidecarSandboxPosture();
      setPosture(res.posture ?? null);
      setEgress(res.egress ?? null);
      if (!res.posture) setUnavailable(t('Could not read sandbox status'));
    } catch {
      // 503 = sidecar 未就绪且没有收容失败记录。
      setPosture(null);
      setEgress(null);
      setUnavailable(t('Sidecar not ready — could not read sandbox status'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPosture();
  }, [fetchPosture]);

  const refusedReason = posture ? REFUSED_REASON_TEXT[posture.reason] : undefined;
  const optOutReason = posture ? OPT_OUT_REASON_TEXT[posture.reason] : undefined;

  return (
    <div className="bg-agent-muted/30 border border-agent-border/60 rounded-agent-md p-2.5 space-y-2">
      <h4 className="text-xs font-semibold text-agent-foreground flex items-center gap-1.5">
        <LuShieldCheck className="h-3.5 w-3.5 text-agent-muted-foreground" />
        {t('Sidecar process sandbox')}
      </h4>

      {!hasHostBridge() ? (
        <p className="text-[11px] text-agent-muted-foreground">{t('Open this in the desktop app')}</p>
      ) : loading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-agent-muted-foreground">
          <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {t('Loading sandbox status...')}
        </div>
      ) : unavailable ? (
        <p className="text-[11px] text-agent-muted-foreground">{unavailable}</p>
      ) : posture && refusedReason ? (
        <div className="rounded-agent-md border border-agent-destructive/20 bg-agent-destructive/10 p-2.5 text-xs text-agent-destructive space-y-1.5">
          <p className="font-medium">
            {t('Cannot contain the process, so startup was refused — {reason}.', {
              reason: t(refusedReason),
            })}
          </p>
          <p>
            {t(
              'The sidecar process that holds the provider API keys did not start, so it is not running without isolation either.',
            )}{' '}
            {t('The only way to run it unsandboxed is to set STEERABLE_SIDECAR_SANDBOX=0 explicitly.')}
          </p>
          <p>
            {t(
              'For isolation, install the containment backend for your platform (macOS Seatbelt, Linux bwrap/Landlock, Windows win-spawn-helper), or run this app in a container.',
            )}
          </p>
        </div>
      ) : posture && optOutReason ? (
        <div className="rounded-agent-md border border-agent-border/60 bg-agent-canvas p-2.5 text-xs text-agent-muted-foreground space-y-1.5">
          <p className="font-medium text-agent-foreground">
            {t('Turned off manually — {reason}.', { reason: t(optOutReason) })}
          </p>
          <p>
            {t(
              'The sidecar process (which holds the provider API keys) runs without OS isolation. To restore it, remove the setting and restart the app.',
            )}
          </p>
        </div>
      ) : posture ? (
        <div className="rounded-agent-md border border-agent-border/60 bg-agent-canvas p-2.5 text-xs text-agent-muted-foreground space-y-1.5">
          <p className="font-medium text-agent-foreground">{activeHeadline(posture.backend)}</p>
          <p>{activeBody(posture.backend)}</p>
        </div>
      ) : null}

      {egress && <EgressPostureRow egress={egress} />}
    </div>
  );
}
