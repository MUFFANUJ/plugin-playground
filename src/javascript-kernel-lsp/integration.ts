import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { showErrorMessage } from '@jupyterlab/apputils';
import {
  ILSPDocumentConnectionManager,
  type TSessionMap,
  type TSpecsMap
} from '@jupyterlab/lsp';
import type { Kernel, ServerConnection } from '@jupyterlab/services';
import { executeJavaScriptKernelVfsInitCode } from '../javascript-kernel-vfs/common';
import {
  JAVASCRIPT_KERNEL_LSP_COMM_TARGET,
  JAVASCRIPT_KERNEL_LSP_LANGUAGES,
  JAVASCRIPT_KERNEL_LSP_MIME_TYPES,
  JAVASCRIPT_KERNEL_LSP_SERVER_ID,
  JAVASCRIPT_PRIMARY_KERNEL_SPEC_NAME
} from '../javascript-kernel-vfs/constants';

/**
 * LSP spec requires a non-empty tuple of language identifiers.
 */
const JAVASCRIPT_KERNEL_LSP_LANGUAGE_LIST: [string, ...string[]] = [
  ...JAVASCRIPT_KERNEL_LSP_LANGUAGES
];

/**
 * MIME types exposed for the in-kernel TypeScript server.
 */
const JAVASCRIPT_KERNEL_LSP_MIME_TYPE_LIST: [string, ...string[]] = [
  ...JAVASCRIPT_KERNEL_LSP_MIME_TYPES
];

/**
 * Probe code used to confirm kernel-side LSP comm registration is ready.
 */
const JAVASCRIPT_KERNEL_LSP_BOOTSTRAP_PROBE_CODE = `(() => {
  if (globalThis.__pluginPlaygroundTypeScriptLspRegistered !== true) {
    throw new Error("__PP_KERNEL_LSP_NOT_READY__");
  }
  if (globalThis.__pluginPlaygroundTypeScriptLspServerId !== ${JSON.stringify(
    JAVASCRIPT_KERNEL_LSP_SERVER_ID
  )}) {
    throw new Error("__PP_KERNEL_LSP_SERVER_ID_MISMATCH__");
  }
})();`;

let sharedJavaScriptKernelConnection: Kernel.IKernelConnection | null = null;
let kernelLspBootstrapWarmup: Promise<void> | null = null;
const kernelLspErrorMessages = new Set<string>();

/**
 * Private fields used by `LanguageServerManager` in `@jupyterlab/lsp`.
 */
interface ILanguageServerManagerPrivate {
  readonly settings: ServerConnection.ISettings;
  readonly sessions: TSessionMap;
  readonly isEnabled: boolean;
  fetchSessions(): Promise<void>;
  _settings: ServerConnection.ISettings;
  _sessions: TSessionMap;
  _specs: TSpecsMap;
  _statusCode: number;
  _ready: {
    resolve(value: void | PromiseLike<void>): void;
  };
  _sessionsChanged: {
    emit(args: void): void;
  };
  __pluginPlaygroundKernelLspPatched?: boolean;
}

function reportKernelLspError(message: string, error: unknown): void {
  console.warn(message, error);
  if (kernelLspErrorMessages.has(message)) {
    return;
  }

  kernelLspErrorMessages.add(message);
  void showErrorMessage(
    message,
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * Resolve a JavaScript kernel connection for comm-based LSP transport.
 *
 * A dedicated kernel is started for the current app lifecycle so the transport
 * is deterministic and does not depend on pre-existing running kernels that
 * may carry stale in-memory bootstrap state from earlier builds.
 */
async function resolveJavaScriptKernelConnection(
  app: JupyterFrontEnd
): Promise<Kernel.IKernelConnection> {
  if (sharedJavaScriptKernelConnection?.isDisposed === false) {
    return sharedJavaScriptKernelConnection;
  }

  const kernelspecManager = app.serviceManager.kernelspecs;
  await kernelspecManager.ready;
  const kernelspecs = kernelspecManager.specs?.kernelspecs;
  if (!kernelspecs || !kernelspecs[JAVASCRIPT_PRIMARY_KERNEL_SPEC_NAME]) {
    throw new Error(
      `Expected JavaScript kernelspec "${JAVASCRIPT_PRIMARY_KERNEL_SPEC_NAME}" was not found.`
    );
  }

  const kernelManager = app.serviceManager.kernels;
  await kernelManager.ready;

  try {
    sharedJavaScriptKernelConnection = await kernelManager.startNew(
      {
        name: JAVASCRIPT_PRIMARY_KERNEL_SPEC_NAME
      },
      {
        handleComms: true
      }
    );
    return sharedJavaScriptKernelConnection;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not start JavaScript kernel "${JAVASCRIPT_PRIMARY_KERNEL_SPEC_NAME}" for LSP comm transport. ${message}`
    );
  }
}

/**
 * Wait until kernel-side LSP comm target registration is available.
 */
async function ensureKernelLspBootstrapReady(
  kernelConnection: Kernel.IKernelConnection
): Promise<void> {
  const initContent = await executeJavaScriptKernelVfsInitCode(
    kernelConnection
  );
  if (initContent.status !== 'ok') {
    const errorName = initContent.ename || 'KernelBootstrapError';
    const errorValue =
      initContent.evalue || 'Kernel bootstrap returned non-ok status.';
    throw new Error(`${errorName}: ${errorValue}`);
  }

  const future = kernelConnection.requestExecute(
    {
      code: JAVASCRIPT_KERNEL_LSP_BOOTSTRAP_PROBE_CODE,
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
  if (content.status === 'ok') {
    return;
  }

  const errorName = content.ename || 'KernelLspProbeError';
  const errorValue =
    content.evalue ||
    'Kernel LSP probe returned non-ok status after bootstrap.';
  throw new Error(`${errorName}: ${errorValue}`);
}

/**
 * Pre-start and bootstrap the dedicated JavaScript kernel early so initial
 * editor interactions do not race with transport startup.
 */
function warmupKernelLspBootstrap(app: JupyterFrontEnd): Promise<void> {
  if (kernelLspBootstrapWarmup) {
    return kernelLspBootstrapWarmup;
  }
  kernelLspBootstrapWarmup = (async () => {
    const kernelConnection = await resolveJavaScriptKernelConnection(app);
    await ensureKernelLspBootstrapReady(kernelConnection);
  })();
  return kernelLspBootstrapWarmup;
}

/**
 * Create a minimal WebSocket-compatible class that tunnels JSON-RPC strings
 * over a Jupyter comm channel to the JavaScript kernel.
 */
function createKernelLspWebSocketClass(app: JupyterFrontEnd): typeof WebSocket {
  class KernelLspWebSocket {
    readonly url: string;

    onopen: ((this: WebSocket, ev: Event) => any) | null = null;
    onmessage: ((this: WebSocket, ev: MessageEvent<any>) => any) | null = null;
    onerror: ((this: WebSocket, ev: Event) => any) | null = null;
    onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null;

    constructor(url: string) {
      this.url = url;
      void this._openCommConnection().catch(error => {
        const message =
          error instanceof Error ? error.message : String(error || 'Error');
        reportKernelLspError(
          'Plugin Playground kernel LSP comm transport failed.',
          error
        );
        this._emitError(message);
        this._closeInternal(1011, message, false);
      });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this._isClosed) {
        return;
      }

      const payload = String(data);
      if (!this._commChannel) {
        this._pendingPayloads.push(payload);
        return;
      }

      this._commChannel.send({ payload });
    }

    close(code = 1000, reason = ''): void {
      this._closeInternal(code, reason, true);
    }

    private async _openCommConnection(): Promise<void> {
      if (this._isClosed) {
        return;
      }

      const kernelConnection = await resolveJavaScriptKernelConnection(app);
      await ensureKernelLspBootstrapReady(kernelConnection);

      const commChannel = kernelConnection.createComm(
        JAVASCRIPT_KERNEL_LSP_COMM_TARGET
      );
      this._commChannel = commChannel;

      commChannel.onMsg = message => {
        const data = message.content.data as { payload?: unknown };
        const payload =
          typeof data?.payload === 'string'
            ? data.payload
            : JSON.stringify(data?.payload ?? data);
        if (this.onmessage) {
          this.onmessage.call(
            this as unknown as WebSocket,
            {
              data: payload
            } as MessageEvent
          );
        }
      };

      commChannel.onClose = () => {
        this._closeInternal(1000, 'Comm closed', false);
      };

      commChannel.open({
        serverId: JAVASCRIPT_KERNEL_LSP_SERVER_ID,
        languages: [...JAVASCRIPT_KERNEL_LSP_LANGUAGES]
      });

      if (this.onopen) {
        this.onopen.call(this as unknown as WebSocket, {} as Event);
      }

      this._flushPendingPayloads();
    }

    private _flushPendingPayloads(): void {
      const commChannel = this._commChannel;
      if (!commChannel) {
        return;
      }

      const pendingPayloads = this._pendingPayloads;
      this._pendingPayloads = [];
      for (const payload of pendingPayloads) {
        commChannel.send({ payload });
      }
    }

    private _emitError(message: string): void {
      if (!this.onerror) {
        return;
      }
      this.onerror.call(
        this as unknown as WebSocket,
        {
          message
        } as unknown as Event
      );
    }

    private _closeInternal(
      code: number,
      reason: string,
      shouldSendClose: boolean
    ): void {
      if (this._isClosed) {
        return;
      }

      this._isClosed = true;

      if (
        this._commChannel &&
        !this._commChannel.isDisposed &&
        shouldSendClose
      ) {
        try {
          this._commChannel.close({
            code,
            reason
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error || 'Error');
          this._emitError(message);
        }
      }
      this._commChannel = null;
      this._pendingPayloads = [];

      if (this.onclose) {
        this.onclose.call(
          this as unknown as WebSocket,
          {
            code,
            reason,
            wasClean: code === 1000
          } as CloseEvent
        );
      }
    }

    private _isClosed = false;
    private _pendingPayloads: string[] = [];
    private _commChannel: Kernel.IComm | null = null;
  }

  return KernelLspWebSocket as unknown as typeof WebSocket;
}

/**
 * Patch the existing LanguageServerManager instance so it exposes a
 * deterministic in-kernel TypeScript LSP endpoint over comms for Lite mode.
 */
function patchLanguageServerManagerForKernelComms(
  app: JupyterFrontEnd,
  connectionManager: { languageServerManager: unknown }
): void {
  const languageServerManager =
    connectionManager.languageServerManager as unknown as ILanguageServerManagerPrivate;

  if (languageServerManager.__pluginPlaygroundKernelLspPatched) {
    return;
  }

  languageServerManager.__pluginPlaygroundKernelLspPatched = true;

  const documentConnectionManager = connectionManager as {
    connect?: (...args: any[]) => Promise<any>;
    connections?: Map<string, unknown>;
    __pluginPlaygroundKernelLspConnectLogged?: boolean;
    __pluginPlaygroundKernelLspPendingConnects?: Map<string, Promise<any>>;
  };
  if (
    !documentConnectionManager.__pluginPlaygroundKernelLspConnectLogged &&
    typeof documentConnectionManager.connect === 'function'
  ) {
    const originalConnect = documentConnectionManager.connect.bind(
      documentConnectionManager
    );
    documentConnectionManager.connect = async (...args: any[]) => {
      const options = args[0] as {
        language?: string;
        virtualDocument?: { uri?: string; documentInfo?: { uri?: string } };
        hasLspSupportedFile?: boolean;
      };
      const virtualUri =
        options?.virtualDocument?.uri ||
        options?.virtualDocument?.documentInfo?.uri ||
        '';
      const existingConnection = virtualUri
        ? documentConnectionManager.connections?.get(virtualUri)
        : undefined;
      if (existingConnection) {
        return existingConnection;
      }
      if (
        !documentConnectionManager.__pluginPlaygroundKernelLspPendingConnects
      ) {
        documentConnectionManager.__pluginPlaygroundKernelLspPendingConnects =
          new Map<string, Promise<any>>();
      }
      const pendingConnect = virtualUri
        ? documentConnectionManager.__pluginPlaygroundKernelLspPendingConnects.get(
            virtualUri
          )
        : undefined;
      if (pendingConnect) {
        return pendingConnect;
      }
      const connectPromise = originalConnect(...args);
      if (virtualUri) {
        documentConnectionManager.__pluginPlaygroundKernelLspPendingConnects.set(
          virtualUri,
          connectPromise
        );
      }
      try {
        return await connectPromise;
      } finally {
        if (virtualUri) {
          documentConnectionManager.__pluginPlaygroundKernelLspPendingConnects.delete(
            virtualUri
          );
        }
      }
    };
    documentConnectionManager.__pluginPlaygroundKernelLspConnectLogged = true;
  }

  const defaultSettings = languageServerManager.settings;
  const kernelWebSocket = createKernelLspWebSocketClass(app);

  languageServerManager.fetchSessions = async (): Promise<void> => {
    if (!languageServerManager.isEnabled) {
      return;
    }

    const spec = {
      display_name: 'TypeScript (JavaScript Kernel)',
      languages: JAVASCRIPT_KERNEL_LSP_LANGUAGE_LIST,
      mime_types: JAVASCRIPT_KERNEL_LSP_MIME_TYPE_LIST,
      requires_documents_on_disk: false,
      version: 2 as const
    };

    languageServerManager._settings = {
      ...defaultSettings,
      WebSocket: kernelWebSocket
    };
    languageServerManager._specs = new Map([
      [JAVASCRIPT_KERNEL_LSP_SERVER_ID, spec]
    ]);
    languageServerManager._sessions = new Map([
      [
        JAVASCRIPT_KERNEL_LSP_SERVER_ID,
        {
          handler_count: 1,
          last_handler_message_at: null,
          last_server_message_at: null,
          status: 'started',
          spec
        }
      ]
    ]);
    languageServerManager._statusCode = 200;
    languageServerManager._sessionsChanged.emit(void 0);
    languageServerManager._ready.resolve(undefined);
  };

  void languageServerManager.fetchSessions().catch(error => {
    reportKernelLspError(
      'Failed to initialize JavaScript kernel LSP manager sessions.',
      error
    );
  });

  void warmupKernelLspBootstrap(app).catch(error => {
    reportKernelLspError(
      'Failed to pre-warm JavaScript kernel LSP bootstrap.',
      error
    );
  });
}

/**
 * Plugin that enables comm-based kernel LSP transport in Lite deployments.
 */
const javaScriptKernelLspCommsPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/plugin-playground:javascript-kernel-lsp-comms',
  description:
    'Routes JupyterLab LSP WebSocket traffic through JavaScript kernel comms in Lite deployments.',
  autoStart: true,
  requires: [ILSPDocumentConnectionManager],
  activate: (
    app: JupyterFrontEnd,
    connectionManager: ILSPDocumentConnectionManager
  ): void => {
    const kernelspecManager = app.serviceManager.kernelspecs;
    const patchIfJavaScriptKernelSpecAvailable = (): boolean => {
      const kernelspecs = kernelspecManager.specs?.kernelspecs;
      if (!kernelspecs || !kernelspecs[JAVASCRIPT_PRIMARY_KERNEL_SPEC_NAME]) {
        return false;
      }
      patchLanguageServerManagerForKernelComms(app, connectionManager);
      return true;
    };

    if (patchIfJavaScriptKernelSpecAvailable()) {
      return;
    }

    const onKernelSpecsChanged = (): void => {
      if (!patchIfJavaScriptKernelSpecAvailable()) {
        return;
      }
      kernelspecManager.specsChanged.disconnect(onKernelSpecsChanged);
    };
    kernelspecManager.specsChanged.connect(onKernelSpecsChanged);

    void kernelspecManager.ready
      .then(() => {
        onKernelSpecsChanged();
      })
      .catch(error => {
        console.warn(
          'Kernel spec manager failed to become ready for kernel LSP comm setup.',
          error
        );
      });
  }
};

const javaScriptKernelLspPlugins: JupyterFrontEndPlugin<any>[] = [
  javaScriptKernelLspCommsPlugin
];

export { javaScriptKernelLspPlugins };
