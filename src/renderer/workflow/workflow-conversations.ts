/** A conversation listed beside a project's subprojects and flows. */
export interface PlanningConversation {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
  readonly providerLabel?: string;
  readonly workspaceLabel?: string;
}
