import { useEffect, useId, useState } from 'react';

import type { BrowserProjectSites, BrowserSettings as Settings, BrowserSitesNotice } from '../../shared/browser';
import type { BrowserAccess } from '../capability-access';
import { useChatCopy } from '../chat/copy';
import { Button, Status, Switch } from '../ui';
import './browser-pane.css';

/**
 * Settings › 에이전트 › 내장 브라우저 (D1). Both switches start off. Sites are allowed in the pane, where the page is in
 * view; this section lists them per project and can take them back.
 */
export function BrowserSettingsSection({ access }: { readonly access: BrowserAccess }): JSX.Element {
  const copy = useChatCopy().browser.settings;
  const titleId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sites, setSites] = useState<readonly BrowserProjectSites[]>([]);
  const [sitesNotice, setSitesNotice] = useState<BrowserSitesNotice>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void access.load().then((state) => {
      if (!alive) return;
      setSettings(state.settings);
      setSites(state.sites);
      setSitesNotice(state.sitesNotice);
    }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [access]);
  const save = (next: Settings): void => {
    const previous = settings;
    setSettings(next);
    setFailed(false);
    void access.save(next).then(setSettings, () => { setSettings(previous); setFailed(true); });
  };
  const revoke = (projectId: string, origin: string): void => {
    setFailed(false);
    void access.revokeSite(projectId, origin).then(setSites, () => setFailed(true));
  };
  const listed = sites.filter((project) => project.origins.length > 0);
  return (
    <section className="status-section browser-settings" aria-labelledby={titleId} data-testid="browser-settings">
      <div>
        <h2 className="status-section-title" id={titleId}>{copy.title}</h2>
        <p className="settings-hint">{copy.hint}</p>
      </div>
      {settings && (
        <>
          <Switch checked={settings.enabled} onChange={(event) => save({ ...settings, enabled: event.target.checked })} label={copy.enable} description={copy.enableHint} data-testid="browser-enabled" />
          <Switch checked={settings.autoCheck} disabled={!settings.enabled} onChange={(event) => save({ ...settings, autoCheck: event.target.checked })} label={copy.autoCheck} description={copy.autoCheckHint} data-testid="browser-auto-check" />
          <div className="browser-settings__group">
            <h3>{copy.profile}</h3>
            <p className="browser-settings__value">{copy.profileValue}</p>
            <p className="settings-hint">{copy.profileHint}</p>
          </div>
          <div className="browser-settings__group">
            <h3>{copy.sites}</h3>
            {sitesNotice && <Status variant={sitesNotice === 'discarded' ? 'danger' : 'warning'} data-testid="browser-sites-notice">{copy.sitesNotice[sitesNotice]}</Status>}
            <p className="settings-hint">{listed.length > 0 ? copy.sitesHint : copy.sitesEmpty}</p>
            {listed.map((project) => (
              <div key={project.projectId}>
                <p className="browser-settings__project">{project.projectName}</p>
                <ul className="browser-settings__sites">
                  {project.origins.map((origin) => (
                    <li key={origin}>
                      <code>{origin}</code>
                      <Button size="sm" variant="ghost" aria-label={copy.revokeLabel(origin)} onClick={() => revoke(project.projectId, origin)}>{copy.revoke}</Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="browser-settings__group browser-settings__clear">
            <h3>{copy.clear}</h3>
            <p className="settings-hint">{copy.clearHint}</p>
            <Button size="sm" variant="danger" onClick={() => void access.clearData().catch(() => setFailed(true))} data-testid="browser-clear-data">{copy.clear}</Button>
          </div>
        </>
      )}
      {failed && <Status variant="danger" live="assertive">{copy.failed}</Status>}
    </section>
  );
}
