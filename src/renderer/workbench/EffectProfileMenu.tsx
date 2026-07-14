import { ChevronDown, ScanLine, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  EFFECT_PROFILE_IDS,
  isEffectProfileAvailable,
  type EffectProfileId,
  type ResolvedEffectProfileId,
} from '../effect-profiles';
import { useAppTranslation } from '../i18n';
import { Button, Menu, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, VisuallyHidden } from '../ui';

const PROFILE_LABEL_KEYS = {
  clean: 'header.profileClean',
  static: 'header.profileStatic',
  'crt-signature': 'header.profileCrtSignature',
  'full-crt': 'header.profileFullCrt',
  custom: 'header.profileCustom',
} as const;

const PROFILE_DESCRIPTION_KEYS = {
  clean: 'header.profileCleanDescription',
  static: 'header.profileStaticDescription',
  'crt-signature': 'header.profileCrtSignatureDescription',
  'full-crt': 'header.profileFullCrtDescription',
} as const;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(media.matches);
    onChange();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  return reduced;
}

export function EffectProfileMenu({
  activeThemeEffects,
  motionEffectsRequested,
  onOpenAdvanced,
  onSelectProfile,
  profile,
}: {
  readonly activeThemeEffects: readonly string[];
  readonly motionEffectsRequested: boolean;
  readonly onOpenAdvanced: () => void;
  readonly onSelectProfile: (profile: EffectProfileId) => void;
  readonly profile: ResolvedEffectProfileId;
}): JSX.Element {
  const { t } = useAppTranslation();
  const reducedMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const profileLabel = t(PROFILE_LABEL_KEYS[profile]);
  const motionPaused = reducedMotion && motionEffectsRequested;
  const motionPausedLabel = motionPaused ? t('header.motionPaused') : null;
  const availableProfiles = new Set(
    EFFECT_PROFILE_IDS.filter((id) => isEffectProfileAvailable({ effects: activeThemeEffects }, id)),
  );

  const openAdvanced = (): void => {
    // SidebarShell captures document.activeElement when it mounts. Move focus
    // off the soon-to-unmount menu item first so closing Settings can restore
    // focus to this stable invoker.
    triggerRef.current?.focus();
    onOpenAdvanced();
  };

  return (
    <>
      <Menu
        className="effect-profile-menu"
        label={t('header.effectsMenu')}
        placement="bottom-start"
        trigger={
          <Button
            ref={triggerRef}
            size="sm"
            variant="ghost"
            className="effect-profile-trigger"
            leadingIcon={<ScanLine />}
            trailingIcon={<ChevronDown />}
            aria-label={`${t('header.effectsTrigger', { profile: profileLabel })}${
              motionPausedLabel ? `. ${motionPausedLabel}` : ''
            }`}
            data-testid="btn-effect-profile"
            data-profile={profile}
          >
            <span className="effect-profile-trigger__fx" aria-hidden="true">
              FX
            </span>
            <span className="effect-profile-trigger__separator" aria-hidden="true">
              ·
            </span>
            <span className="effect-profile-trigger__value">{profileLabel}</span>
          </Button>
        }
      >
        <MenuLabel>{t('header.effects')}</MenuLabel>
        {EFFECT_PROFILE_IDS.map((id) => (
          <MenuRadioItem
            key={id}
            checked={profile === id}
            disabled={!availableProfiles.has(id)}
            onSelect={() => onSelectProfile(id)}
            data-testid={`effect-profile-${id}`}
          >
            <span className="effect-profile-option">
              <span className="effect-profile-option__name">{t(PROFILE_LABEL_KEYS[id])}</span>
              <span className="effect-profile-option__description">{t(PROFILE_DESCRIPTION_KEYS[id])}</span>
            </span>
          </MenuRadioItem>
        ))}
        {motionPausedLabel && (
          <div className="effect-profile-motion-note" aria-hidden="true">
            {motionPausedLabel}
          </div>
        )}
        <MenuSeparator />
        <MenuItem icon={SlidersHorizontal} onSelect={openAdvanced} data-testid="effect-profile-advanced">
          {t('header.advancedEffects')}
        </MenuItem>
      </Menu>
      {motionPausedLabel && (
        <VisuallyHidden role="status" aria-live="polite" data-testid="effect-profile-motion-status">
          {motionPausedLabel}
        </VisuallyHidden>
      )}
    </>
  );
}
