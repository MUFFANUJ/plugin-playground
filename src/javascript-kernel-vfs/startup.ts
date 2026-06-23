import type { Token } from '@lumino/coreutils';
import {
  createJavaScriptKernelVfsStartupModuleUrl,
  JAVASCRIPT_KERNEL_VFS_LSP_TARGET_EXPORT
} from './common';
import { JAVASCRIPT_KERNEL_LSP_COMM_TARGET } from './constants';

const JAVASCRIPT_KERNEL_VFS_STARTUP_EXTENSION_ID =
  '@jupyterlab/plugin-playground:javascript-kernel-vfs-lsp';

declare const require: (module: string) => {
  IJavaScriptKernelStartup: Token<IJavaScriptKernelStartupRegistry>;
};

interface IJavaScriptKernelStartupRegistry {
  registerStartupExtension(extension: {
    id: string;
    commTargets: ReadonlyArray<{
      targetName: string;
      module: string;
      exportName: string;
    }>;
  }): void;
}

const {
  IJavaScriptKernelStartup: javaScriptKernelStartupToken
} = require('@jupyterlite/javascript-kernel');

function setupJavaScriptKernelVfs(
  startup: IJavaScriptKernelStartupRegistry
): void {
  const module = createJavaScriptKernelVfsStartupModuleUrl();
  startup.registerStartupExtension({
    id: JAVASCRIPT_KERNEL_VFS_STARTUP_EXTENSION_ID,
    commTargets: [
      {
        targetName: JAVASCRIPT_KERNEL_LSP_COMM_TARGET,
        module,
        exportName: JAVASCRIPT_KERNEL_VFS_LSP_TARGET_EXPORT
      }
    ]
  });
}

export { javaScriptKernelStartupToken, setupJavaScriptKernelVfs };
export type { IJavaScriptKernelStartupRegistry };
