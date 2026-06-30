export class RefreshCoordinator {
  private running = false;
  private queued = false;

  constructor(private readonly runRefresh: () => Promise<void>) {}

  async request(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.queued = false;
        await this.runRefresh();
      } while (this.queued);
    } finally {
      this.running = false;
    }
  }
}
