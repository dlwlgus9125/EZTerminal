import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  MAX_QUICK_COMMAND_CHARS,
  MAX_QUICK_COMMAND_DESCRIPTION_CHARS,
  MAX_QUICK_COMMAND_NAME_CHARS,
  QuickCommandInputSchema,
  type QuickCommand,
  type QuickCommandInput,
} from '../shared/quick-command';
import { useAppTranslation } from './i18n';
import './quick-open.css';

export type QuickOpenMode = 'all' | 'commands';
export type QuickOpenRowKind = 'pane' | 'file' | 'history' | 'quick-command' | 'action' | 'preset' | 'agent';
export type QuickOpenActionVariant = 'enter' | 'shift-enter' | 'mod-enter';

export interface QuickOpenRow {
  /** Must be stable and unique within this kind for the lifetime of the modal. */
  readonly id: string;
  readonly kind: QuickOpenRowKind;
  readonly title: string;
  readonly detail?: string;
  readonly disabledReason?: string;
  /** Overrides the default source badge, for example "Codex" for an agent row. */
  readonly sourceLabel?: string;
  /** Overrides the default group, for example "Recent" in an empty-query list. */
  readonly groupLabel?: string;
}

export interface QuickOpenRowGroup {
  readonly label: string;
  readonly rows: readonly QuickOpenRow[];
}

export type QuickCommandField = 'name' | 'command' | 'description';
export type QuickCommandFieldErrors = Partial<Record<QuickCommandField, string>>;

export type QuickCommandManageResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      readonly fieldErrors?: QuickCommandFieldErrors;
    };

type MaybePromise<T> = T | Promise<T>;

export interface QuickCommandManagerConfig {
  readonly commands: readonly QuickCommand[];
  readonly onCreate: (input: QuickCommandInput) => MaybePromise<QuickCommandManageResult>;
  readonly onUpdate: (id: string, input: QuickCommandInput) => MaybePromise<QuickCommandManageResult>;
  readonly onDelete: (id: string) => MaybePromise<QuickCommandManageResult>;
}

export interface QuickOpenModalProps {
  readonly mode: QuickOpenMode;
  /** Controlled query. The caller owns debounce, cancellation, and source loading. */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** Already-ranked async source results for a non-empty query. */
  readonly rows: readonly QuickOpenRow[];
  /** Caller-selected recent/useful rows shown instead of `rows` for an empty query. */
  readonly emptyRows?: readonly QuickOpenRow[];
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  readonly emptyMessage?: string;
  readonly noResultsMessage?: string;
  /** Non-row-specific action/search feedback supplied by the App coordinator. */
  readonly actionMessage?: string | null;
  readonly onAction: (row: QuickOpenRow, variant: QuickOpenActionVariant) => void;
  readonly onClose: () => void;
  readonly quickCommandManager?: QuickCommandManagerConfig;
}

const KIND_GROUP: Record<QuickOpenRowKind, string> = {
  pane: 'Open panes',
  file: 'Files',
  history: 'History',
  'quick-command': 'Quick Commands',
  action: 'Actions',
  preset: 'Presets',
  agent: 'Agents',
};

export function groupQuickOpenRows(
  rows: readonly QuickOpenRow[],
  kindGroups: Readonly<Record<QuickOpenRowKind, string>> = KIND_GROUP,
): QuickOpenRowGroup[] {
  const groups = new Map<string, QuickOpenRow[]>();
  for (const row of rows) {
    const label = row.groupLabel ?? kindGroups[row.kind];
    const group = groups.get(label);
    if (group) group.push(row);
    else groups.set(label, [row]);
  }
  return [...groups].map(([label, groupedRows]) => ({
    label,
    rows: groupedRows,
  }));
}

export type QuickCommandDraftValidation =
  | { readonly ok: true; readonly input: QuickCommandInput }
  | { readonly ok: false; readonly fieldErrors: QuickCommandFieldErrors };

export function validateQuickCommandDraft(draft: {
  readonly name: string;
  readonly command: string;
  readonly description: string;
}): QuickCommandDraftValidation {
  const parsed = QuickCommandInputSchema.safeParse(draft);
  if (parsed.success) return { ok: true, input: parsed.data };
  const fieldErrors: QuickCommandFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if ((field === 'name' || field === 'command' || field === 'description') && fieldErrors[field] === undefined) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'button:not(:disabled)',
    'input:not(:disabled)',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    'a[href]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return [...container.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  );
}

interface IndexedGroup {
  readonly label: string;
  readonly rows: readonly {
    readonly row: QuickOpenRow;
    readonly index: number;
  }[];
}

function indexGroups(groups: readonly QuickOpenRowGroup[]): IndexedGroup[] {
  let index = 0;
  return groups.map((group) => ({
    label: group.label,
    rows: group.rows.map((row) => ({ row, index: index++ })),
  }));
}

export function QuickOpenModal({
  mode,
  query,
  onQueryChange,
  rows,
  emptyRows = [],
  loading = false,
  loadingLabel,
  emptyMessage,
  noResultsMessage,
  actionMessage = null,
  onAction,
  onClose,
  quickCommandManager,
}: QuickOpenModalProps): JSX.Element {
  const { t } = useAppTranslation();
  const [view, setView] = useState<'results' | 'manage'>('results');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const instanceId = useId().replace(/:/g, '');
  const titleId = `${instanceId}-title`;
  const listId = `${instanceId}-list`;

  const displayedRows = query.trim() === '' ? emptyRows : rows;
  const groups = useMemo(
    () =>
      groupQuickOpenRows(displayedRows, {
        pane: t('commandCenter.groups.panes'),
        file: t('commandCenter.groups.files'),
        history: t('commandCenter.groups.history'),
        'quick-command': t('commandCenter.groups.quickCommands'),
        action: t('commandCenter.groups.actions'),
        preset: t('commandCenter.groups.presets'),
        agent: t('commandCenter.groups.agents'),
      }),
    [displayedRows, t],
  );
  const indexedGroups = useMemo(() => indexGroups(groups), [groups]);
  const flatRows = useMemo(() => indexedGroups.flatMap((group) => group.rows.map(({ row }) => row)), [indexedGroups]);
  const rowSignature = flatRows.map((row) => `${row.kind}:${row.id}`).join('\0');
  const selectedRow = flatRows[selectedIndex];
  const activeDescendant = selectedRow ? `${instanceId}-option-${selectedIndex}` : undefined;

  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queryRef.current?.focus();
    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [mode, query, rowSignature]);

  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, flatRows.length - 1)));
  }, [flatRows.length]);

  useEffect(() => {
    rowRefs.current.get(selectedIndex)?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    if (view === 'results') queryRef.current?.focus();
  }, [view]);

  useEffect(() => {
    if (!quickCommandManager && view === 'manage') setView('results');
  }, [quickCommandManager, view]);

  const activate = (row: QuickOpenRow | undefined, variant: QuickOpenActionVariant): void => {
    if (!row || row.disabledReason) return;
    onAction(row, variant);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex((current) => Math.min(current + 1, Math.max(0, flatRows.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex(Math.max(0, flatRows.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const variant: QuickOpenActionVariant =
        event.ctrlKey || event.metaKey ? 'mod-enter' : event.shiftKey ? 'shift-enter' : 'enter';
      activate(selectedRow, variant);
    }
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = focusableElements(dialogRef.current);
    if (focusables.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const current = document.activeElement;
    const currentIndex = focusables.indexOf(current as HTMLElement);
    if (event.shiftKey && currentIndex <= 0) {
      event.preventDefault();
      focusables[focusables.length - 1].focus();
    } else if (!event.shiftKey && (currentIndex < 0 || currentIndex === focusables.length - 1)) {
      event.preventDefault();
      focusables[0].focus();
    }
  };

  return (
    <div className="quick-open-overlay" data-testid="quick-open-overlay">
      <div
        ref={dialogRef}
        className="quick-open-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={loading}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        data-view={view}
        data-testid="quick-open-modal"
      >
        <header className="quick-open-header">
          <div className="quick-open-heading">
            <span className="quick-open-mode" aria-hidden="true">
              {view === 'manage'
                ? t('commandCenter.manageMode')
                : mode === 'commands'
                  ? t('commandCenter.commandsMode')
                  : t('commandCenter.allMode')}
            </span>
            <h1 id={titleId}>{view === 'manage' ? t('quickCommands.title') : t('commandCenter.title')}</h1>
          </div>
          <div className="quick-open-header-actions">
            {view === 'results' && quickCommandManager && (
              <button type="button" className="btn quick-open-manage" onClick={() => setView('manage')}>
                {t('quickCommands.manage')}
              </button>
            )}
            {view === 'manage' && (
              <button type="button" className="btn" onClick={() => setView('results')}>
                {t('common.back')}
              </button>
            )}
            <button
              type="button"
              className="btn quick-open-close"
              onClick={onClose}
              aria-label={t('commandCenter.close')}
            >
              {t('common.close')}
            </button>
          </div>
        </header>

        {view === 'results' ? (
          <>
            <input
              ref={queryRef}
              className="quick-open-input"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={
                mode === 'commands'
                  ? t('commandCenter.searchCommandsPlaceholder')
                  : t('commandCenter.searchAllPlaceholder')
              }
              aria-label={mode === 'commands' ? t('commandCenter.searchCommands') : t('commandCenter.searchAll')}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeDescendant}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              data-testid="quick-open-input"
            />
            <div className="quick-open-list" id={listId} role="listbox" aria-label={t('commandCenter.results')}>
              {indexedGroups.map((group, groupIndex) => (
                <section
                  className="quick-open-group"
                  role="group"
                  aria-labelledby={`${instanceId}-group-${groupIndex}`}
                  key={group.label}
                >
                  <h2 id={`${instanceId}-group-${groupIndex}`}>{group.label}</h2>
                  {group.rows.map(({ row, index }) => {
                    const selected = index === selectedIndex;
                    return (
                      <div
                        ref={(element) => {
                          if (element) rowRefs.current.set(index, element);
                          else rowRefs.current.delete(index);
                        }}
                        id={`${instanceId}-option-${index}`}
                        key={`${row.kind}:${row.id}`}
                        className={`quick-open-row${selected ? ' quick-open-row--selected' : ''}${row.disabledReason ? ' quick-open-row--disabled' : ''}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={row.disabledReason ? 'true' : undefined}
                        data-kind={row.kind}
                        data-testid={`quick-open-row-${row.kind}-${row.id}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => setSelectedIndex(index)}
                        onClick={() => activate(row, 'enter')}
                      >
                        <span className="quick-open-source">
                          {row.sourceLabel ?? t(`commandCenter.kinds.${row.kind}`)}
                        </span>
                        <span className="quick-open-row-copy">
                          <span className="quick-open-row-title" title={row.title}>
                            {row.title}
                          </span>
                          {row.detail && (
                            <span className="quick-open-row-detail" title={row.detail}>
                              {row.detail}
                            </span>
                          )}
                          {row.disabledReason && (
                            <span className="quick-open-row-disabled-reason">{row.disabledReason}</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </section>
              ))}

              {loading && (
                <div className="quick-open-loading" role="status" aria-live="polite" data-testid="quick-open-loading">
                  <span className="quick-open-loading-mark" aria-hidden="true" />
                  {loadingLabel ?? t('commandCenter.searchingSources')}
                </div>
              )}
              {!loading && flatRows.length === 0 && (
                <div className="quick-open-empty" role="status" data-testid="quick-open-empty">
                  {query.trim() === ''
                    ? (emptyMessage ?? t('commandCenter.empty'))
                    : (noResultsMessage ?? t('commandCenter.noMatchingItems'))}
                </div>
              )}
            </div>
            <footer className="quick-open-footer">
              <span>
                <kbd>Enter</kbd> {t('commandCenter.hints.openInsert')}
              </span>
              <span>
                <kbd>Shift</kbd>+<kbd>Enter</kbd> {t('commandCenter.hints.alternate')}
              </span>
              <span>
                <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> {t('commandCenter.hints.run')}
              </span>
              {(actionMessage || selectedRow?.disabledReason) && (
                <span className="quick-open-footer-reason" role="status">
                  {actionMessage ?? selectedRow?.disabledReason}
                </span>
              )}
            </footer>
          </>
        ) : quickCommandManager ? (
          <QuickCommandEditor manager={quickCommandManager} />
        ) : null}
      </div>
    </div>
  );
}

interface DraftState {
  readonly name: string;
  readonly command: string;
  readonly description: string;
}

const EMPTY_DRAFT: DraftState = { name: '', command: '', description: '' };

function QuickCommandEditor({ manager }: { readonly manager: QuickCommandManagerConfig }): JSX.Element {
  const { t } = useAppTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [fieldErrors, setFieldErrors] = useState<QuickCommandFieldErrors>({});
  const [message, setMessage] = useState<{
    readonly kind: 'error' | 'success';
    readonly text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const formId = useId().replace(/:/g, '');

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const startCreate = (): void => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFieldErrors({});
    setMessage(null);
    setConfirmDeleteId(null);
    queueMicrotask(() => nameRef.current?.focus());
  };

  const startEdit = (command: QuickCommand): void => {
    setEditingId(command.id);
    setDraft({
      name: command.name,
      command: command.command,
      description: command.description ?? '',
    });
    setFieldErrors({});
    setMessage(null);
    setConfirmDeleteId(null);
    queueMicrotask(() => nameRef.current?.focus());
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    const validated = validateQuickCommandDraft(draft);
    if (!validated.ok) {
      setFieldErrors({
        ...(validated.fieldErrors.name
          ? { name: t('quickCommands.nameInvalid', { max: MAX_QUICK_COMMAND_NAME_CHARS }) }
          : {}),
        ...(validated.fieldErrors.command
          ? { command: t('quickCommands.commandInvalid', { max: MAX_QUICK_COMMAND_CHARS }) }
          : {}),
        ...(validated.fieldErrors.description
          ? {
              description: t('quickCommands.descriptionInvalid', {
                max: MAX_QUICK_COMMAND_DESCRIPTION_CHARS,
              }),
            }
          : {}),
      });
      setMessage({ kind: 'error', text: t('quickCommands.fixFields') });
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setMessage(null);
    let result: QuickCommandManageResult;
    try {
      result = editingId ? await manager.onUpdate(editingId, validated.input) : await manager.onCreate(validated.input);
    } catch {
      result = { ok: false, message: t('quickCommands.saveFailed') };
    }
    setSaving(false);
    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setMessage({ kind: 'error', text: result.message });
      return;
    }
    setMessage({
      kind: 'success',
      text: editingId ? t('quickCommands.updated') : t('quickCommands.created'),
    });
    if (!editingId) setDraft(EMPTY_DRAFT);
  };

  const remove = async (id: string): Promise<void> => {
    if (deletingId) return;
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      setMessage(null);
      return;
    }

    setDeletingId(id);
    let result: QuickCommandManageResult;
    try {
      result = await manager.onDelete(id);
    } catch {
      result = { ok: false, message: t('quickCommands.deleteFailed') };
    }
    setDeletingId(null);
    setConfirmDeleteId(null);
    if (!result.ok) {
      setMessage({ kind: 'error', text: result.message });
      return;
    }
    if (editingId === id) startCreate();
    setMessage({ kind: 'success', text: t('quickCommands.deleted') });
  };

  const fieldErrorId = (field: QuickCommandField): string | undefined =>
    fieldErrors[field] ? `${formId}-${field}-error` : undefined;

  return (
    <div className="quick-command-editor" data-testid="quick-command-editor">
      <aside className="quick-command-editor-list" aria-label={t('quickCommands.savedAria')}>
        <div className="quick-command-editor-list-head">
          <h2>{t('quickCommands.saved')}</h2>
          <button type="button" className="btn" onClick={startCreate}>
            {t('quickCommands.new')}
          </button>
        </div>
        {manager.commands.length === 0 ? (
          <div className="quick-command-editor-empty">{t('quickCommands.empty')}</div>
        ) : (
          manager.commands.map((command) => (
            <div
              className={`quick-command-editor-item${editingId === command.id ? ' quick-command-editor-item--active' : ''}`}
              key={command.id}
              data-testid={`quick-command-editor-item-${command.id}`}
            >
              <button type="button" className="quick-command-editor-select" onClick={() => startEdit(command)}>
                <span>{command.name}</span>
                <small>{command.command}</small>
              </button>
              <button
                type="button"
                className="btn quick-command-editor-delete"
                disabled={deletingId !== null}
                onClick={() => void remove(command.id)}
                aria-label={
                  confirmDeleteId === command.id
                    ? t('quickCommands.confirmDeleteNamed', {
                        name: command.name,
                      })
                    : t('quickCommands.deleteNamed', { name: command.name })
                }
              >
                {deletingId === command.id
                  ? t('quickCommands.deleting')
                  : confirmDeleteId === command.id
                    ? t('common.confirm')
                    : t('quickCommands.delete')}
              </button>
            </div>
          ))
        )}
      </aside>

      <form className="quick-command-editor-form" onSubmit={(event) => void save(event)} noValidate>
        <h2>{editingId ? t('quickCommands.edit') : t('quickCommands.new')}</h2>
        <label htmlFor={`${formId}-name`}>{t('quickCommands.name')}</label>
        <input
          ref={nameRef}
          id={`${formId}-name`}
          value={draft.name}
          maxLength={MAX_QUICK_COMMAND_NAME_CHARS}
          aria-invalid={fieldErrors.name ? 'true' : undefined}
          aria-describedby={fieldErrorId('name')}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
        {fieldErrors.name && (
          <span id={`${formId}-name-error`} className="quick-command-field-error">
            {fieldErrors.name}
          </span>
        )}

        <label htmlFor={`${formId}-command`}>{t('quickCommands.command')}</label>
        <input
          id={`${formId}-command`}
          value={draft.command}
          maxLength={MAX_QUICK_COMMAND_CHARS}
          aria-invalid={fieldErrors.command ? 'true' : undefined}
          aria-describedby={fieldErrorId('command')}
          onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
        />
        {fieldErrors.command && (
          <span id={`${formId}-command-error`} className="quick-command-field-error">
            {fieldErrors.command}
          </span>
        )}

        <label htmlFor={`${formId}-description`}>
          {t('quickCommands.description')} <span>{t('quickCommands.optional')}</span>
        </label>
        <input
          id={`${formId}-description`}
          value={draft.description}
          maxLength={MAX_QUICK_COMMAND_DESCRIPTION_CHARS}
          aria-invalid={fieldErrors.description ? 'true' : undefined}
          aria-describedby={fieldErrorId('description')}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              description: event.target.value,
            }))
          }
        />
        {fieldErrors.description && (
          <span id={`${formId}-description-error`} className="quick-command-field-error">
            {fieldErrors.description}
          </span>
        )}

        {message && (
          <div
            className={`quick-command-editor-message quick-command-editor-message--${message.kind}`}
            role={message.kind === 'error' ? 'alert' : 'status'}
          >
            {message.text}
          </div>
        )}
        <div className="quick-command-editor-form-actions">
          <button type="button" className="btn" onClick={startCreate} disabled={saving}>
            {t('quickCommands.clear')}
          </button>
          <button type="submit" className="btn btn-run" disabled={saving}>
            {saving
              ? t('quickCommands.saving')
              : editingId
                ? t('quickCommands.saveChanges')
                : t('quickCommands.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
