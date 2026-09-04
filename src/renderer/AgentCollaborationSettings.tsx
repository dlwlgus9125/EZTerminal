import { Bot, GitBranch, PackagePlus, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  type AgentOrchestrationSnapshot,
  type AgentProfile,
} from '../shared/agent-orchestration';
import {
  type AgentAdapterInstallPreview,
  type AgentAdapterSnapshot,
  type InstalledAgentAdapter,
} from '../shared/agent-adapter';
import { useAppTranslation } from './i18n';
import { Badge, Button, Dialog, IconButton, Switch } from './ui';

const EMPTY_ADAPTER_SNAPSHOT: AgentAdapterSnapshot = {
  revision: 0,
  adapters: [],
  trustedPublishers: [],
};

function capabilityLabel(profile: AgentProfile): string {
  const labels: string[] = [];
  if (profile.capabilities.includes('read')) labels.push('read');
  if (profile.capabilities.includes('write')) labels.push('write');
  if (profile.capabilities.includes('verify')) labels.push('verify');
  return labels.join(' / ');
}

export function AgentCollaborationSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<AgentOrchestrationSnapshot>(EMPTY_AGENT_ORCHESTRATION_SNAPSHOT);
  const [adapterSnapshot, setAdapterSnapshot] = useState<AgentAdapterSnapshot>(EMPTY_ADAPTER_SNAPSHOT);
  const [adapterPreview, setAdapterPreview] = useState<AgentAdapterInstallPreview | null>(null);
  const [trustPublisher, setTrustPublisher] = useState(false);
  const [approveExpansion, setApproveExpansion] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<InstalledAgentAdapter | null>(null);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const applySnapshot = useCallback((next: AgentOrchestrationSnapshot): void => {
    setSnapshot((current) => next.revision < current.revision ? current : next);
  }, []);

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return undefined;
    void desktop.getAgentOrchestrationSnapshot()
      .then(applySnapshot)
      .catch(() => setMessage(t('collaboration.unavailable')));
    return desktop.onAgentOrchestrationSnapshot(applySnapshot);
  }, [applySnapshot, t]);

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return undefined;
    void desktop.getAgentAdapterSnapshot()
      .then(setAdapterSnapshot)
      .catch(() => setMessage(t('collaboration.adaptersUnavailable')));
    return desktop.onAgentAdapterSnapshot(setAdapterSnapshot);
  }, [t]);

  const providers = useMemo(
    () => new Map(snapshot.providers.map((provider) => [provider.providerId, provider])),
    [snapshot.providers],
  );

  const confirmMigration = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const migration = await desktop.confirmLegacyTeamMigration();
      setSnapshot((current) => ({ ...current, revision: current.revision + 1, migration }));
      setMigrationOpen(false);
      setMessage(t('collaboration.migrationComplete'));
    } catch {
      setMessage(t('collaboration.migrationFailed'));
    } finally {
      setBusy(false);
    }
  };

  const selectAdapter = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await desktop.selectAgentAdapterBundle();
      if (!result) return;
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setTrustPublisher(!result.value.trustRequired);
      setApproveExpansion(result.value.capabilityExpansion.length === 0);
      setAdapterPreview(result.value);
    } catch {
      setMessage(t('collaboration.adapterInspectFailed'));
    } finally {
      setBusy(false);
    }
  };

  const installAdapter = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !adapterPreview || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await desktop.installAgentAdapter({
        token: adapterPreview.token,
        trustPublisher,
        approveCapabilityExpansion: approveExpansion,
      });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setAdapterPreview(null);
      setMessage(t('collaboration.adapterInstalled', { name: result.value.name }));
    } catch {
      setMessage(t('collaboration.adapterInstallFailed'));
    } finally {
      setBusy(false);
    }
  };

  const setAdapterEnabled = async (adapter: InstalledAgentAdapter, enabled: boolean): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await desktop.setAgentAdapterEnabled(adapter.adapterId, enabled);
      if (!result.ok) setMessage(result.message);
    } catch {
      setMessage(t('collaboration.adapterStateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const removeAdapter = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !removeTarget || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await desktop.removeAgentAdapter(removeTarget.adapterId);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setRemoveTarget(null);
      setMessage(t('collaboration.adapterRemoved'));
    } catch {
      setMessage(t('collaboration.adapterRemoveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-collaboration-settings">
      <div className="agent-collaboration-settings__intro">
        <GitBranch aria-hidden="true" />
        <div>
          <p>{t('collaboration.description')}</p>
          <p className="settings-hint">{t('collaboration.boundaryHint')}</p>
        </div>
      </div>

      {snapshot.migration.required && (
        <section className="agent-collaboration-migration" aria-labelledby="collaboration-migration-title">
          <TriangleAlert aria-hidden="true" />
          <div>
            <h3 id="collaboration-migration-title">{t('collaboration.migrationTitle')}</h3>
            <p>{t('collaboration.migrationSummary', {
              catalog: snapshot.migration.catalogItemCount,
              runs: snapshot.migration.runCount,
            })}</p>
          </div>
          <Button size="sm" variant="danger" onClick={() => setMigrationOpen(true)}>
            {t('collaboration.reviewMigration')}
          </Button>
        </section>
      )}

      <section className="agent-collaboration-settings__section" aria-labelledby="collaboration-profiles-title">
        <div className="settings-agent-generic-head">
          <h3 id="collaboration-profiles-title" className="settings-agent-subtitle">
            {t('collaboration.workerProfiles')}
          </h3>
          <Badge>{t('collaboration.profileCount', { count: snapshot.profiles.length })}</Badge>
        </div>
        <p className="settings-hint">{t('collaboration.profileHint')}</p>
        <div className="agent-collaboration-profile-list">
          {snapshot.profiles.map((profile) => (
            <article className="agent-collaboration-profile" key={profile.profileId}>
              <Bot aria-hidden="true" />
              <div className="agent-collaboration-profile__copy">
                <strong>{profile.name}</strong>
                <span>{providers.get(profile.providerId)?.displayName ?? profile.providerId}</span>
                <small>{profile.description}</small>
              </div>
              <div className="agent-collaboration-profile__status">
                <Badge variant={profile.available ? 'success' : 'neutral'}>
                  {profile.available ? t('collaboration.ready') : t('collaboration.unavailableProfile')}
                </Badge>
                <small>{capabilityLabel(profile)}</small>
              </div>
            </article>
          ))}
          {snapshot.profiles.length === 0 && (
            <p className="settings-hint">{t('collaboration.noProfiles')}</p>
          )}
        </div>
      </section>

      <section className="agent-collaboration-settings__section" aria-labelledby="collaboration-adapters-title">
        <div className="settings-agent-generic-head">
          <h3 id="collaboration-adapters-title" className="settings-agent-subtitle">
            {t('collaboration.adapters')}
          </h3>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<PackagePlus />}
            loading={busy}
            onClick={() => void selectAdapter()}
          >
            {t('collaboration.installAdapter')}
          </Button>
        </div>
        <p className="settings-hint">{t('collaboration.adapterHint')}</p>
        <div className="agent-collaboration-adapter-list">
          {adapterSnapshot.adapters.map((adapter) => (
            <article className="agent-collaboration-adapter" key={adapter.adapterId}>
              <div className="agent-collaboration-adapter__copy">
                <strong>{adapter.name} <small>v{adapter.version}</small></strong>
                <span>{t('collaboration.publishedBy', { publisher: adapter.publisherName })}</span>
                <small>{adapter.description}</small>
                {adapter.healthMessage && <small>{adapter.healthMessage}</small>}
              </div>
              <div className="agent-collaboration-adapter__actions">
                <Badge variant={adapter.health === 'healthy' ? 'success' : adapter.health === 'failed' ? 'danger' : 'neutral'}>
                  {t(`collaboration.adapterHealth.${adapter.health}`)}
                </Badge>
                <Switch
                  checked={adapter.enabled}
                  disabled={busy}
                  label={t('collaboration.adapterEnabled')}
                  onChange={(event) => void setAdapterEnabled(adapter, event.currentTarget.checked)}
                />
                <IconButton
                  icon={Trash2}
                  aria-label={t('collaboration.removeAdapterName', { name: adapter.name })}
                  disabled={busy}
                  onClick={() => setRemoveTarget(adapter)}
                />
              </div>
            </article>
          ))}
          {adapterSnapshot.adapters.length === 0 && (
            <p className="settings-hint">{t('collaboration.noAdapters')}</p>
          )}
        </div>
      </section>

      <section className="agent-collaboration-settings__section agent-collaboration-security" aria-labelledby="collaboration-security-title">
        <ShieldCheck aria-hidden="true" />
        <div>
          <h3 id="collaboration-security-title" className="settings-agent-subtitle">
            {t('collaboration.securityTitle')}
          </h3>
          <p className="settings-hint">{t('collaboration.securityHint')}</p>
        </div>
      </section>

      {message && <p className="settings-agent-message" role="status">{message}</p>}

      <Dialog
        open={migrationOpen}
        onOpenChange={setMigrationOpen}
        title={t('collaboration.migrationDialogTitle')}
        description={t('collaboration.migrationDialogDescription')}
        role="alertdialog"
        tone="danger"
        dismissible={!busy}
        footer={(
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setMigrationOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void confirmMigration()}>
              {t('collaboration.deleteLegacy')}
            </Button>
          </>
        )}
      >
        <p>{t('collaboration.migrationCounts', {
          catalog: snapshot.migration.catalogItemCount,
          runs: snapshot.migration.runCount,
        })}</p>
        <p className="settings-agent-warning">{t('collaboration.migrationIrreversible')}</p>
      </Dialog>

      <Dialog
        open={adapterPreview !== null}
        onOpenChange={(open) => { if (!open && !busy) setAdapterPreview(null); }}
        title={adapterPreview?.update ? t('collaboration.updateAdapter') : t('collaboration.installAdapter')}
        description={adapterPreview?.description}
        tone="warning"
        dismissible={!busy}
        footer={(
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setAdapterPreview(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={Boolean(adapterPreview?.trustRequired && !trustPublisher)
                || Boolean(adapterPreview?.capabilityExpansion.length && !approveExpansion)}
              onClick={() => void installAdapter()}
            >
              {adapterPreview?.update ? t('collaboration.updateAdapter') : t('collaboration.installAdapter')}
            </Button>
          </>
        )}
      >
        {adapterPreview && (
          <div className="agent-adapter-review">
            <dl>
              <div><dt>{t('collaboration.adapterName')}</dt><dd>{adapterPreview.name} v{adapterPreview.version}</dd></div>
              <div><dt>{t('collaboration.publisher')}</dt><dd>{adapterPreview.publisherName}</dd></div>
              <div><dt>{t('collaboration.publisherKey')}</dt><dd><code>{adapterPreview.publisherKeyId.slice(0, 16)}…</code></dd></div>
              <div><dt>{t('collaboration.capabilities')}</dt><dd>{adapterPreview.capabilities.join(', ')}</dd></div>
            </dl>
            <p className="settings-agent-warning">{t('collaboration.executableWarning')}</p>
            {adapterPreview.trustRequired && (
              <Switch
                checked={trustPublisher}
                label={t('collaboration.trustPublisher', { publisher: adapterPreview.publisherName })}
                description={t('collaboration.trustPublisherHint')}
                onChange={(event) => setTrustPublisher(event.currentTarget.checked)}
              />
            )}
            {adapterPreview.capabilityExpansion.length > 0 && adapterPreview.update && (
              <Switch
                checked={approveExpansion}
                label={t('collaboration.approveExpansion')}
                description={adapterPreview.capabilityExpansion.join(', ')}
                onChange={(event) => setApproveExpansion(event.currentTarget.checked)}
              />
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open && !busy) setRemoveTarget(null); }}
        title={t('collaboration.removeAdapter')}
        description={t('collaboration.removeAdapterDescription', { name: removeTarget?.name ?? '' })}
        tone="danger"
        role="alertdialog"
        dismissible={!busy}
        footer={(
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setRemoveTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={busy} onClick={() => void removeAdapter()}>{t('common.remove')}</Button>
          </>
        )}
      >
        <p className="settings-agent-warning">{t('collaboration.removeAdapterHint')}</p>
      </Dialog>
    </div>
  );
}
