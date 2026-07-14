import type { InterferenceParams } from './effect-params';

/**
 * Param slider group for ONE CRT-interference effect (crt-interference) —
 * the shared desktop/mobile presentational block rendered beneath that
 * effect's toggle, mirroring SettingsPanel's inline rollbar sliders and
 * reusing their CSS classes (`.settings-rollbar-params`/`-row`), so both
 * platforms pick the styling up from the shared index.css with zero new CSS.
 * Bounds here mirror effect-params.ts's clamp ranges (which stay the single
 * enforcement authority — the slider min/max is just UX).
 */

export type InterferenceEffectId = keyof InterferenceParams;

export function isInterferenceEffectId(id: string): id is InterferenceEffectId {
  return id === 'jitter-burst' || id === 'micro-jitter' || id === 'static-noise' || id === 'flicker';
}

interface SliderSpec {
  readonly key: string;
  readonly label: (value: number) => string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

const SLIDERS: Record<InterferenceEffectId, readonly SliderSpec[]> = {
  'jitter-burst': [
    { key: 'period', label: (v) => `Burst period: ${v}s`, min: 1, max: 30 },
    { key: 'duration', label: (v) => `Burst length: ${v}ms`, min: 50, max: 1000, step: 50 },
    { key: 'intensity', label: (v) => `Intensity: ${v}px`, min: 1, max: 20 },
  ],
  'micro-jitter': [
    { key: 'speed', label: (v) => `Jitter speed: ${v}`, min: 1, max: 20 },
    { key: 'amplitude', label: (v) => `Amplitude: ${v}px`, min: 1, max: 5 },
  ],
  'static-noise': [
    { key: 'density', label: (v) => `Grain density: ${v}%`, min: 1, max: 100 },
    { key: 'opacity', label: (v) => `Noise opacity: ${v}%`, min: 1, max: 100 },
    { key: 'speed', label: (v) => `Shuffle speed: ${v}`, min: 1, max: 20 },
  ],
  flicker: [
    { key: 'frequency', label: (v) => `Frequency: ${v}Hz`, min: 1, max: 30 },
    { key: 'depth', label: (v) => `Depth: ${v}%`, min: 1, max: 40 },
  ],
};

interface EffectParamSlidersProps {
  readonly effectId: InterferenceEffectId;
  readonly params: InterferenceParams;
  readonly onChange: (effectId: InterferenceEffectId, partial: Record<string, number | boolean>) => void;
  /** Optional localized label formatter; desktop keeps the catalog defaults. */
  readonly formatLabel?: (effectId: InterferenceEffectId, key: string, value: number) => string;
  readonly flashLabel?: string;
}

export function EffectParamSliders({
  effectId,
  params,
  onChange,
  formatLabel,
  flashLabel = 'Noise flash during burst',
}: EffectParamSlidersProps): JSX.Element {
  const values: Record<string, number | boolean> = params[effectId];
  return (
    <div className="settings-rollbar-params" data-testid={`settings-fx-${effectId}-params`}>
      {SLIDERS[effectId].map(({ key, label, min, max, step }) => (
        <label key={key} className="settings-rollbar-row">
          <span>{formatLabel?.(effectId, key, values[key] as number) ?? label(values[key] as number)}</span>
          <input
            type="range"
            min={min}
            max={max}
            step={step ?? 1}
            value={values[key] as number}
            onChange={(e) => onChange(effectId, { [key]: Number(e.target.value) })}
            data-testid={`settings-fx-${effectId}-${key}`}
          />
        </label>
      ))}
      {effectId === 'jitter-burst' && (
        <label className="settings-rollbar-row">
          <span>{flashLabel}</span>
          <input
            type="checkbox"
            checked={params['jitter-burst'].flash}
            onChange={(e) => onChange('jitter-burst', { flash: e.target.checked })}
            data-testid="settings-fx-jitter-burst-flash"
          />
        </label>
      )}
    </div>
  );
}
