export interface FileSaveCoordinatorOptions {
  readonly debounceMs: number;
  readonly initialContents?: string;
  readonly persist: (contents: string) => Promise<void>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
  readonly onError?: (error: unknown) => void;
}

export class FileSaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents: string;
  private confirmedContents: string | null;
  private latestRevision = 0;
  private persistedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private savePromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly options: FileSaveCoordinatorOptions) {
    this.latestContents = options.initialContents ?? "";
    this.confirmedContents = options.initialContents ?? null;
  }

  change(contents: string): void {
    if (this.latestRevision !== this.persistedRevision && contents === this.latestContents) {
      return;
    }

    if (!this.saving && contents === this.confirmedContents) {
      this.latestContents = contents;
      this.latestRevision = this.persistedRevision;
      this.clearTimer();
      this.options.onPendingChange(false);
      return;
    }

    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    this.disposePromise ??= this.flushForDispose();
    return this.disposePromise;
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving) {
      await this.savePromise;
      return;
    }
    if (this.latestRevision === this.persistedRevision) return;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    let succeeded = false;
    const savePromise = this.options
      .persist(contents)
      .then(() => {
        succeeded = true;
        this.persistedRevision = revision;
        this.confirmedContents = contents;
        this.options.onConfirmed(contents);
      })
      .catch((error: unknown) => {
        this.options.onError?.(error);
      });
    this.savePromise = savePromise;
    try {
      await savePromise;
    } finally {
      if (this.savePromise === savePromise) {
        this.savePromise = null;
      }
      this.saving = false;
    }

    if (revision === this.latestRevision) {
      if (succeeded) this.options.onPendingChange(false);
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }

  private async flushForDispose(): Promise<void> {
    while (this.latestRevision !== this.persistedRevision) {
      const latestRevisionBeforePersist = this.latestRevision;
      const persistedRevisionBeforePersist = this.persistedRevision;
      await this.persistLatest();
      if (
        this.latestRevision === latestRevisionBeforePersist &&
        this.persistedRevision === persistedRevisionBeforePersist
      ) {
        return;
      }
    }
  }
}
