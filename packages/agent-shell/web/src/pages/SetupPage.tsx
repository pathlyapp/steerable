/**
 * First-run setup: connect a model before the chat, on the framework's own
 * shell only.
 *
 * The panel is the same component the settings screen uses, so a key entered
 * here is saved and verified exactly as it would be there; this page only adds
 * the surrounding copy and the step out of the way. Products that ship their
 * own brand never see it (see `BRAND_FIRST_RUN`).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { BRAND_NAME } from '@/brand';
import { LlmSettingsPanel, type LlmSettingsPanelHandle } from '@/components/settings/LlmSettingsPanel';
import { t } from '@/i18n';
import { getLlmCredential } from '@/lib/local-api';

/** What the first-run page should render for a credential answer. */
export type SetupDecision = 'chat' | 'form';

/**
 * Decides between the chat and the setup form.
 *
 * A failed read is treated as "go to the chat": refusing to show the app
 * because one endpoint failed would be worse than letting the turn report its
 * own failure, which is already a designed path.
 *
 * @param status Credential status, or null when it could not be read.
 * @returns Which screen to show.
 */
export function setupDecision(status: { ok: boolean } | null): SetupDecision {
  if (!status) return 'chat';
  return status.ok ? 'chat' : 'form';
}

/** Reads the credential once; renders nothing while the answer is unknown. */
export function SetupPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<'checking' | 'needed' | 'ready'>('checking');
  const panel = useRef<LlmSettingsPanelHandle>(null);

  useEffect(() => {
    let cancelled = false;
    void getLlmCredential()
      .then((status) => {
        if (cancelled) return;
        setState(setupDecision(status) === 'chat' ? 'ready' : 'needed');
      })
      .catch(() => {
        // A failed read is not proof that a credential is missing; let the
        // chat page show its own failure card instead of trapping the user.
        if (!cancelled) setState('ready');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state === 'ready') navigate('/', { replace: true });
  }, [navigate, state]);

  if (state === 'checking') return null;

  return (
    <div className="flex h-full w-full items-start justify-center overflow-auto bg-agent-canvas px-6 py-10">
      <div className="w-full max-w-xl">
        <h1 className="text-lg font-semibold text-agent-foreground">
          {t('Connect a model to get started')}
        </h1>
        <p className="mt-2 text-xs text-agent-muted-foreground">
          {t('{name} needs a model service to work. The key stays on this computer.', { name: BRAND_NAME })}
        </p>
        <div className="mt-6">
          <LlmSettingsPanel
            ref={panel}
            showFooterSave
            onSaved={() => {
              void getLlmCredential().then((status) => {
                if (setupDecision(status) === 'chat') navigate('/', { replace: true });
              });
            }}
          />
        </div>
        <button
          type="button"
          className="mt-4 text-xs text-agent-muted-foreground underline underline-offset-2 hover:text-agent-foreground"
          onClick={() => navigate('/', { replace: true })}
        >
          {t('Set up later')}
        </button>
      </div>
    </div>
  );
}
