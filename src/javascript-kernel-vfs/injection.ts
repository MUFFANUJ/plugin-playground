import { JupyterFrontEnd } from '@jupyterlab/application';
import { createJavaScriptKernelVfsInitCode } from './bootstrap';

/**
 * Kernel spec names used by JavaScript kernels in this project.
 */
const JAVASCRIPT_KERNEL_NAMES = new Set(['javascript', 'javascript-worker']);

/**
 * Kernel statuses that indicate restart is in progress.
 */
const KERNEL_RESTART_STATUSES = new Set(['restarting', 'autorestarting']);

/**
 * Silent kernel-side probe used to validate that the VFS bootstrap globals are
 * present and shape-compatible.
 */
const VFS_BOOTSTRAP_PROBE_CODE = `(() => {
  const hasUsableTypeScript = candidate =>
    !!candidate &&
    typeof candidate === "object" &&
    typeof candidate.createProgram === "function" &&
    typeof candidate.createSourceFile === "function" &&
    typeof candidate.ScriptTarget === "object";
  const hasUsableTypeScriptVfs = candidate =>
    !!candidate &&
    typeof candidate === "object" &&
    typeof candidate.createSystem === "function" &&
    typeof candidate.createVirtualTypeScriptEnvironment === "function";

  if (!hasUsableTypeScript(globalThis.ts)) {
    throw new Error("__PP_TS_MISSING__");
  }
  if (!hasUsableTypeScript(globalThis.vfsBundledTs)) {
    throw new Error("__PP_BUNDLED_TS_MISSING__");
  }
  if (typeof globalThis.vfsCreateDefaultMapFromBundledLibs !== "function") {
    throw new Error("__PP_VFS_LIB_MAP_FACTORY_MISSING__");
  }
  if (!hasUsableTypeScriptVfs(globalThis.tsvfs)) {
    throw new Error("__PP_TSVFS_MISSING__");
  }
  if (!hasUsableTypeScriptVfs(globalThis.vfs)) {
    throw new Error("__PP_VFS_MISSING__");
  }
})();`;

/**
 * Subset of kernel model fields used by the injection controller.
 */
interface IKernelModel {
  readonly id: string;
  readonly name: string;
}

type IKernelConnection = ReturnType<
  JupyterFrontEnd['serviceManager']['kernels']['connectTo']
>;

type IKernelConnectTo =
  JupyterFrontEnd['serviceManager']['kernels']['connectTo'];

/**
 * Ensures JavaScript kernels expose bundled TypeScript + `@typescript/vfs`
 * globals so users can run VFS APIs without network fetches.
 */
export class JavaScriptKernelVfsInjectionController {
  constructor(private app: JupyterFrontEnd) {}

  /**
   * Register manager hooks and run an initial injection pass.
   */
  setup(): void {
    const kernelManager = this.app.serviceManager.kernels;

    this._patchKernelManagerConnectTo(kernelManager);

    kernelManager.runningChanged.connect((_sender, kernels) => {
      const shouldSchedule = this._shouldScheduleInjectionForRunningKernels(
        kernelManager,
        kernels as IKernelModel[]
      );
      const activeJavaScriptKernelIds = new Set<string>();
      for (const kernelModel of this._collectActiveJavaScriptKernelModels(
        kernelManager
      )) {
        activeJavaScriptKernelIds.add(kernelModel.id);
      }
      this._removeStaleKernelTracking(activeJavaScriptKernelIds);
      if (!shouldSchedule) {
        return;
      }
      this._scheduleJavaScriptKernelVfsInjection();
    });

    void kernelManager.ready
      .then(() => {
        this._scheduleJavaScriptKernelVfsInjection();
      })
      .catch(error => {
        console.warn(
          'Kernel manager failed to become ready for VFS injection.',
          error
        );
      });
  }

  private async _queueJavaScriptKernelVfsInjection(): Promise<void> {
    if (this._javascriptKernelVfsInjectionPending) {
      return this._javascriptKernelVfsInjectionPending;
    }

    const pending = this._injectVfsIntoRunningJavaScriptKernels().finally(
      () => {
        if (this._javascriptKernelVfsInjectionPending === pending) {
          this._javascriptKernelVfsInjectionPending = null;
        }
      }
    );

    this._javascriptKernelVfsInjectionPending = pending;
    return pending;
  }

  private _scheduleJavaScriptKernelVfsInjection(): void {
    void this._queueJavaScriptKernelVfsInjection().catch(error => {
      console.warn(
        'Failed to initialize @typescript/vfs in JavaScript kernels.',
        error
      );
    });
  }

  private async _injectVfsIntoRunningJavaScriptKernels(): Promise<void> {
    const kernelManager = this.app.serviceManager.kernels;

    await kernelManager.ready;
    await kernelManager.refreshRunning();

    const activeJavaScriptKernelIds = new Set<string>();
    const activeKernelModels =
      this._collectActiveJavaScriptKernelModels(kernelManager);
    const kernelsToInject: IKernelModel[] = [];

    for (const kernelModel of activeKernelModels) {
      const kernelId = kernelModel.id;
      activeJavaScriptKernelIds.add(kernelId);
      this._ensureKernelStatusSubscription(kernelManager, kernelModel);

      if (this._vfsInjectedKernelIds.has(kernelId)) {
        // Probe only when restart status has flagged this kernel.
        if (!this._vfsProbeKernelIds.has(kernelId)) {
          continue;
        }

        this._vfsProbeKernelIds.delete(kernelId);
        const hasBootstrap = await this._kernelHasVfsBootstrap(
          kernelManager,
          kernelModel
        );
        if (hasBootstrap) {
          continue;
        }
        this._vfsInjectedKernelIds.delete(kernelId);
      }

      kernelsToInject.push(kernelModel);
    }

    if (kernelsToInject.length === 0) {
      this._removeStaleKernelTracking(activeJavaScriptKernelIds);
      return;
    }

    for (const kernelModel of kernelsToInject) {
      await this._injectVfsIntoKernel(kernelManager, kernelModel);
    }

    this._removeStaleKernelTracking(activeJavaScriptKernelIds);
  }

  private _getJavaScriptKernelVfsInitCode(): string {
    if (this._javascriptKernelVfsInitCode) {
      return this._javascriptKernelVfsInitCode;
    }
    this._javascriptKernelVfsInitCode = createJavaScriptKernelVfsInitCode();
    return this._javascriptKernelVfsInitCode;
  }

  private async _kernelHasVfsBootstrap(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels'],
    kernelModel: { id: string; name: string }
  ): Promise<boolean> {
    const kernelConnection = this._connectToKernel(kernelManager, kernelModel);

    try {
      const future = kernelConnection.requestExecute(
        {
          code: VFS_BOOTSTRAP_PROBE_CODE,
          silent: true,
          store_history: false,
          allow_stdin: false
        },
        true
      );
      const reply = await future.done;
      const content = reply.content as { status?: string };
      return content.status === 'ok';
    } catch {
      return false;
    } finally {
      kernelConnection.dispose();
    }
  }

  /**
   * Inject bundled TypeScript + VFS globals into a specific JavaScript kernel.
   *
   * Returns true only when bootstrap execute reply is `ok` and the follow-up
   * probe confirms all expected globals are present and shape-compatible.
   */
  private async _injectVfsIntoKernel(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels'],
    kernelModel: IKernelModel
  ): Promise<boolean> {
    const kernelId = kernelModel.id;
    if (this._vfsInjectingKernelIds.has(kernelId)) {
      return true;
    }

    this._vfsInjectingKernelIds.add(kernelId);
    const kernelConnection = this._connectToKernel(kernelManager, kernelModel);

    try {
      const initCode = this._getJavaScriptKernelVfsInitCode();
      const future = kernelConnection.requestExecute(
        {
          code: initCode,
          silent: true,
          store_history: false,
          allow_stdin: false
        },
        true
      );
      const reply = await future.done;
      const content = reply.content as {
        status?: string;
        ename?: string;
        evalue?: string;
      };

      if (content.status !== 'ok') {
        const errorName = content.ename || 'KernelError';
        const errorValue =
          content.evalue ||
          `VFS bootstrap failed with status ${content.status}.`;
        throw new Error(`${errorName}: ${errorValue}`);
      }

      const hasBootstrap = await this._kernelHasVfsBootstrap(
        kernelManager,
        kernelModel
      );
      if (!hasBootstrap) {
        throw new Error(
          'VFS bootstrap probe failed after initialization execute reply.'
        );
      }

      this._vfsInjectedKernelIds.add(kernelId);
      this._vfsProbeKernelIds.delete(kernelId);
      return true;
    } catch (error) {
      this._vfsInjectedKernelIds.delete(kernelId);
      console.warn(
        `Failed to initialize @typescript/vfs in kernel "${kernelModel.name}" (${kernelId}).`,
        error
      );
      return false;
    } finally {
      kernelConnection.dispose();
      this._vfsInjectingKernelIds.delete(kernelId);
    }
  }

  private _collectActiveJavaScriptKernelModels(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels']
  ): IKernelModel[] {
    const kernelModels: IKernelModel[] = [];

    for (const kernelModel of [...kernelManager.running()] as IKernelModel[]) {
      if (!JAVASCRIPT_KERNEL_NAMES.has(kernelModel.name)) {
        continue;
      }
      kernelModels.push(kernelModel);
    }

    return kernelModels;
  }

  private _shouldScheduleInjectionForRunningKernels(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels'],
    kernels: ReadonlyArray<IKernelModel>
  ): boolean {
    let shouldSchedule = false;

    for (const kernelModel of kernels) {
      if (!JAVASCRIPT_KERNEL_NAMES.has(kernelModel.name)) {
        continue;
      }

      const kernelId = kernelModel.id;
      this._ensureKernelStatusSubscription(kernelManager, kernelModel);
      if (!this._vfsInjectedKernelIds.has(kernelId)) {
        // New JavaScript kernel: inject immediately.
        shouldSchedule = true;
      }
    }

    return shouldSchedule;
  }

  private _ensureKernelStatusSubscription(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels'],
    kernelModel: IKernelModel
  ): void {
    const kernelId = kernelModel.id;
    const existingConnection = this._kernelStatusConnectionsById.get(kernelId);
    if (existingConnection && !existingConnection.isDisposed) {
      return;
    }
    if (existingConnection?.isDisposed) {
      this._kernelStatusConnectionsById.delete(kernelId);
    }

    const kernelConnection = this._connectToKernel(kernelManager, kernelModel);

    kernelConnection.statusChanged.connect((_sender, status) => {
      if (!KERNEL_RESTART_STATUSES.has(status)) {
        return;
      }
      this._vfsProbeKernelIds.add(kernelId);
      this._scheduleJavaScriptKernelVfsInjection();
    });

    kernelConnection.disposed.connect(() => {
      const currentConnection = this._kernelStatusConnectionsById.get(kernelId);
      if (currentConnection !== kernelConnection) {
        return;
      }

      this._kernelStatusConnectionsById.delete(kernelId);
      if (!this._vfsInjectedKernelIds.has(kernelId)) {
        return;
      }

      // If a tracked connection disappears (for example on restart), probe once
      // after the kernel is available again to recover lost globals.
      this._vfsProbeKernelIds.add(kernelId);
      this._scheduleJavaScriptKernelVfsInjection();
    });

    this._kernelStatusConnectionsById.set(kernelId, kernelConnection);
  }

  private _disposeKernelStatusSubscription(kernelId: string): void {
    const kernelConnection = this._kernelStatusConnectionsById.get(kernelId);
    if (!kernelConnection) {
      return;
    }
    this._kernelStatusConnectionsById.delete(kernelId);
    kernelConnection.dispose();
  }

  private _removeStaleKernelTracking(activeKernelIds: Set<string>): void {
    for (const kernelId of this._vfsInjectedKernelIds) {
      if (!activeKernelIds.has(kernelId)) {
        this._vfsInjectedKernelIds.delete(kernelId);
      }
    }

    for (const kernelId of this._vfsProbeKernelIds) {
      if (!activeKernelIds.has(kernelId)) {
        this._vfsProbeKernelIds.delete(kernelId);
      }
    }

    for (const kernelId of this._kernelStatusConnectionsById.keys()) {
      if (!activeKernelIds.has(kernelId)) {
        this._disposeKernelStatusSubscription(kernelId);
      }
    }
  }

  private _patchKernelManagerConnectTo(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels']
  ): void {
    if (this._kernelManagerConnectToPatched) {
      return;
    }

    const originalConnectTo = kernelManager.connectTo.bind(kernelManager);
    this._kernelManagerConnectTo = originalConnectTo;

    kernelManager.connectTo = ((options: Parameters<IKernelConnectTo>[0]) => {
      const kernelConnection = originalConnectTo(options);
      if (!this._shouldBypassConnectToTracking) {
        this._trackKernelConnectionFromAnyConnect(
          kernelManager,
          kernelConnection
        );
      }
      return kernelConnection;
    }) as IKernelConnectTo;

    this._kernelManagerConnectToPatched = true;
  }

  private _connectToKernel(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels'],
    kernelModel: { id: string; name: string }
  ): IKernelConnection {
    const connect =
      this._kernelManagerConnectTo ||
      kernelManager.connectTo.bind(kernelManager);
    this._shouldBypassConnectToTracking = true;
    try {
      return connect({
        model: kernelModel,
        handleComms: false
      });
    } finally {
      this._shouldBypassConnectToTracking = false;
    }
  }

  private _trackKernelConnectionFromAnyConnect(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels'],
    kernelConnection: IKernelConnection
  ): void {
    const kernelName = kernelConnection.name;
    if (!JAVASCRIPT_KERNEL_NAMES.has(kernelName)) {
      return;
    }

    const kernelModel = {
      id: kernelConnection.id,
      name: kernelName
    };

    this._ensureKernelStatusSubscription(kernelManager, kernelModel);
    if (this._vfsInjectedKernelIds.has(kernelModel.id)) {
      return;
    }
    void this._injectVfsIntoKernel(kernelManager, kernelModel).then(
      injected => {
        if (!injected) {
          this._scheduleJavaScriptKernelVfsInjection();
        }
      }
    );
  }

  private _kernelManagerConnectTo: IKernelConnectTo | null = null;
  private _kernelManagerConnectToPatched = false;
  private _shouldBypassConnectToTracking = false;

  private readonly _vfsInjectedKernelIds = new Set<string>();
  private readonly _vfsInjectingKernelIds = new Set<string>();
  private readonly _vfsProbeKernelIds = new Set<string>();
  private readonly _kernelStatusConnectionsById = new Map<
    string,
    IKernelConnection
  >();
  private _javascriptKernelVfsInitCode: string | null = null;
  private _javascriptKernelVfsInjectionPending: Promise<void> | null = null;
}
