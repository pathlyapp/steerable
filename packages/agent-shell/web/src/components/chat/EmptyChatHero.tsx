import { BRAND_HOME_HINT, BRAND_NAME, getBrandLogoUrl } from '@/brand';
import { t } from '@/i18n';

/**
 * 新对话落地页与空会话首屏的品牌区：侧栏同一枚 logo，加一句
 * 产品可配的副文案（brand.homeHint）。
 */
export function EmptyChatHero() {
  const hint = BRAND_HOME_HINT.trim();
  return (
    <div className="text-center">
      <h1>
        <img
          src={getBrandLogoUrl()}
          alt={BRAND_NAME}
          className="mx-auto h-12 w-auto max-w-[12rem] select-none object-contain"
          draggable={false}
        />
      </h1>
      {hint ? <p className="mt-1.5 text-xs text-agent-muted-foreground">{t(hint)}</p> : null}
    </div>
  );
}
