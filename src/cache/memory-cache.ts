export class MemoryCache {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async getStats(): Promise<{
    connected: boolean;
    keysCount?: number;
    memoryUsage?: string;
  }> {
    return {
      connected: this.connected,
      keysCount: 0,
      memoryUsage: "0.00KB",
    };
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}
