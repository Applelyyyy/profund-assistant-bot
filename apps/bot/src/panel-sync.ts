import type { PanelScope } from "../../../packages/shared/src/live-updates";
import type { Settings } from "../../../packages/shared/src/index";

// The existing bot tick owns scheduling; no second timer or Gateway worker is created.
export class PanelSyncScheduler {
  private due: number | undefined;
  private revision = 0;
  private lastSync = 0;
  private scopes: Set<PanelScope> | null = null;
  request(
    now = Date.now(),
    debounce = 1500,
    scopes?: readonly PanelScope[] | null,
  ) {
    if (scopes?.length === 0) return;
    if (this.due === undefined) this.scopes = scopes ? new Set(scopes) : null;
    else if (!scopes) this.scopes = null;
    else for (const scope of scopes) this.scopes?.add(scope);
    this.due ??= now + debounce;
  }
  constructor(
    private sync: (
      checkExisting: boolean,
      scopes?: readonly PanelScope[] | null,
    ) => Promise<void>,
  ) {}
  async tick(
    settings: Settings,
    revision: number,
    now = Date.now(),
    scopes?: readonly PanelScope[] | null,
  ) {
    if (revision !== this.revision) {
      this.revision = revision;
      this.request(now, settings.embedUpdateDebounceMs, scopes);
    }
    const periodic =
      settings.embedAutoRefreshEnabled &&
      now - this.lastSync >= settings.embedRefreshIntervalSeconds * 1000;
    if (!periodic && (this.due === undefined || now < this.due)) return;
    const pending = this.due;
    const selected = periodic
      ? undefined
      : this.scopes
        ? [...this.scopes]
        : undefined;
    this.due = undefined;
    try {
      if (selected === undefined) await this.sync(periodic);
      else await this.sync(periodic, selected);
      this.lastSync = now;
    } catch (error) {
      this.due ??= pending ?? now + settings.embedUpdateDebounceMs;
      this.scopes = null;
      throw error;
    }
  }
}
