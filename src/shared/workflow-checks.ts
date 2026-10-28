/** 확인 명령 동의 as the desktop renderer sees it (src/main/workflow-command-consent.ts keeps the allowances). */

/** One check as the person sees it before allowing it. */
export interface WorkflowCheckStatus {
  readonly nodeId: string;
  readonly checkId: string;
  readonly command: string;
  readonly digest: string;
  readonly allowed: boolean;
  /** Why the person is asked: a new command, a changed command, or the same command whose script changed. */
  readonly reason?: 'new' | 'changed' | 'script-changed';
  /** The scripts the command calls (names only), e.g. `package.json#test`. */
  readonly scripts: readonly string[];
  /** The command allowed before, when it changed. */
  readonly before?: string;
}

export type WorkflowCheckConsentResult =
  | { readonly ok: true; readonly checks: readonly WorkflowCheckStatus[] }
  | { readonly ok: false; readonly error: string; readonly message: string };
