import { JupyterFrontEnd } from '@jupyterlab/application';

/**
 * Kernel spec names used by the JavaScript worker kernels in this project.
 */
const JAVASCRIPT_KERNEL_NAMES = new Set(['javascript', 'javascript-worker']);

/**
 * Execution states that indicate a kernel is actively restarting.
 *
 * We use these to trigger a one-time post-restart probe instead of probing on
 * every `runningChanged` emission.
 */
const KERNEL_RESTART_STATES = new Set(['starting', 'restarting']);

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
  readonly execution_state?: string;
}

/**
 * Ensures JavaScript kernels expose bundled TypeScript + `@typescript/vfs`
 * globals so users can run VFS APIs without network fetches.
 */
export class JavaScriptKernelVfsInjectionController {
  constructor(private app: JupyterFrontEnd) {}

  /**
   * Register kernel-manager hooks and run an initial injection pass.
   */
  setup(): void {
    const kernelManager = this.app.serviceManager.kernels;
    const scheduleInjection = () => {
      void this._queueJavaScriptKernelVfsInjection().catch(error => {
        console.warn(
          'Failed to initialize @typescript/vfs in JavaScript kernels.',
          error
        );
      });
    };

    kernelManager.runningChanged.connect((_sender, kernels) => {
      const shouldSchedule =
        this._shouldScheduleInjectionForRunningKernels(kernels);
      if (!shouldSchedule) {
        return;
      }
      scheduleInjection();
    });

    void kernelManager.ready
      .then(() => {
        scheduleInjection();
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

  private async _injectVfsIntoRunningJavaScriptKernels(): Promise<void> {
    const kernelManager = this.app.serviceManager.kernels;
    await kernelManager.ready;
    await kernelManager.refreshRunning();

    const activeJavaScriptKernelIds = new Set<string>();
    const runningKernels = [...kernelManager.running()] as IKernelModel[];
    const kernelsToInject: IKernelModel[] = [];

    for (const kernelModel of runningKernels) {
      if (!JAVASCRIPT_KERNEL_NAMES.has(kernelModel.name)) {
        continue;
      }

      const kernelId = kernelModel.id;
      activeJavaScriptKernelIds.add(kernelId);
      this._kernelExecutionStateById.set(kernelId, kernelModel.execution_state);
      if (this._vfsInjectedKernelIds.has(kernelId)) {
        // Probe only when a restart transition has flagged this kernel.
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

    const initCode = await this._getJavaScriptKernelVfsInitCode();

    for (const kernelModel of kernelsToInject) {
      const kernelConnection = kernelManager.connectTo({
        model: kernelModel,
        handleComms: false
      });
      try {
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
        this._vfsInjectedKernelIds.add(kernelModel.id);
        this._vfsProbeKernelIds.delete(kernelModel.id);
      } catch (error) {
        console.warn(
          `Failed to initialize @typescript/vfs in kernel "${kernelModel.name}" (${kernelModel.id}).`,
          error
        );
      } finally {
        kernelConnection.dispose();
      }
    }

    this._removeStaleKernelTracking(activeJavaScriptKernelIds);
  }

  private async _getJavaScriptKernelVfsInitCode(): Promise<string> {
    if (this._javascriptKernelVfsInitCode) {
      return this._javascriptKernelVfsInitCode;
    }
    if (this._javascriptKernelVfsInitCodePending) {
      return this._javascriptKernelVfsInitCodePending;
    }

    const pending = import('./bootstrap')
      .then(module => module.createJavaScriptKernelVfsInitCode())
      .then(code => {
        this._javascriptKernelVfsInitCode = code;
        return code;
      })
      .finally(() => {
        if (this._javascriptKernelVfsInitCodePending === pending) {
          this._javascriptKernelVfsInitCodePending = null;
        }
      });

    this._javascriptKernelVfsInitCodePending = pending;
    return pending;
  }

  private async _kernelHasVfsBootstrap(
    kernelManager: JupyterFrontEnd['serviceManager']['kernels'],
    kernelModel: { id: string; name: string }
  ): Promise<boolean> {
    const kernelConnection = kernelManager.connectTo({
      model: kernelModel,
      handleComms: false
    });
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

  private _shouldScheduleInjectionForRunningKernels(
    kernels: ReadonlyArray<IKernelModel>
  ): boolean {
    const activeJavaScriptKernelIds = new Set<string>();
    let shouldSchedule = false;

    for (const kernelModel of kernels) {
      if (!JAVASCRIPT_KERNEL_NAMES.has(kernelModel.name)) {
        continue;
      }

      const kernelId = kernelModel.id;
      activeJavaScriptKernelIds.add(kernelId);
      const isRestartTransition = this._isRestartTransition(
        kernelId,
        kernelModel.execution_state
      );
      if (!this._vfsInjectedKernelIds.has(kernelId)) {
        // New JavaScript kernel: inject immediately.
        shouldSchedule = true;
        continue;
      }
      if (isRestartTransition) {
        // Existing injected kernel restarted: mark for one probe.
        this._vfsProbeKernelIds.add(kernelId);
        shouldSchedule = true;
      }
    }

    this._removeStaleKernelTracking(activeJavaScriptKernelIds);
    return shouldSchedule;
  }

  private _isRestartTransition(
    kernelId: string,
    executionState: string | undefined
  ): boolean {
    const previousState = this._kernelExecutionStateById.get(kernelId);
    this._kernelExecutionStateById.set(kernelId, executionState);
    if (previousState === undefined) {
      return false;
    }
    // Detect only "entering restart state" edges to keep scheduling deterministic.
    return (
      !KERNEL_RESTART_STATES.has(previousState) &&
      !!executionState &&
      KERNEL_RESTART_STATES.has(executionState)
    );
  }

  private _removeStaleKernelTracking(activeKernelIds: Set<string>): void {
    for (const kernelId of this._vfsInjectedKernelIds) {
      if (!activeKernelIds.has(kernelId)) {
        this._vfsInjectedKernelIds.delete(kernelId);
      }
    }
    for (const kernelId of this._kernelExecutionStateById.keys()) {
      if (!activeKernelIds.has(kernelId)) {
        this._kernelExecutionStateById.delete(kernelId);
      }
    }
    for (const kernelId of this._vfsProbeKernelIds) {
      if (!activeKernelIds.has(kernelId)) {
        this._vfsProbeKernelIds.delete(kernelId);
      }
    }
  }

  private readonly _vfsInjectedKernelIds = new Set<string>();
  private readonly _vfsProbeKernelIds = new Set<string>();
  private readonly _kernelExecutionStateById = new Map<
    string,
    string | undefined
  >();
  private _javascriptKernelVfsInitCode: string | null = null;
  private _javascriptKernelVfsInitCodePending: Promise<string> | null = null;
  private _javascriptKernelVfsInjectionPending: Promise<void> | null = null;
}
