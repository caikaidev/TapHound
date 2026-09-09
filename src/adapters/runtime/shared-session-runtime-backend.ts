import type { DeviceInfo } from "../../domain/runtime.js";
import type {
  OpenRuntimeSessionOptions,
  RuntimeBackend,
  RuntimeSession
} from "../../ports/runtime-backend.js";

export class SharedSessionRuntimeBackend implements RuntimeBackend {
  private readonly sessions = new Map<string, Promise<RuntimeSession>>();

  public constructor(private readonly backend: RuntimeBackend) {}

  public get descriptor(): RuntimeBackend["descriptor"] {
    return this.backend.descriptor;
  }

  public get capabilities(): RuntimeBackend["capabilities"] {
    return this.backend.capabilities;
  }

  public listDevices(signal?: AbortSignal): Promise<readonly DeviceInfo[]> {
    return this.backend.listDevices(signal);
  }

  public openSession(
    options: OpenRuntimeSessionOptions
  ): Promise<RuntimeSession> {
    const existing = this.sessions.get(options.deviceSerial);
    if (existing !== undefined) {
      return existing;
    }
    const opened = this.backend.openSession(options);
    opened.catch(() => {
      if (this.sessions.get(options.deviceSerial) === opened) {
        this.sessions.delete(options.deviceSerial);
      }
    });
    this.sessions.set(options.deviceSerial, opened);
    return opened;
  }

  public async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session): Promise<void> => (
      session.then(
        (opened): Promise<void> => opened.close(),
        () => undefined
      )
    )));
  }
}
