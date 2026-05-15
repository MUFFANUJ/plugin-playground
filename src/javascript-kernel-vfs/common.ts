import { createJavaScriptKernelVfsInitCode } from './bootstrap';
import type { Kernel } from '@jupyterlab/services';

const javaScriptKernelVfsInitCode = createJavaScriptKernelVfsInitCode();

interface IKernelBootstrapExecuteReply {
  status?: string;
  ename?: string;
  evalue?: string;
}

/**
 * Execute the shared bootstrap payload in a kernel and return execute reply
 * content for caller-specific validation and error handling.
 */
async function executeJavaScriptKernelVfsInitCode(
  kernelConnection: Pick<Kernel.IKernelConnection, 'requestExecute'>
): Promise<IKernelBootstrapExecuteReply> {
  const future = kernelConnection.requestExecute(
    {
      code: javaScriptKernelVfsInitCode,
      silent: true,
      store_history: false,
      allow_stdin: false
    },
    true
  );
  const reply = await future.done;
  return reply.content as IKernelBootstrapExecuteReply;
}

export { executeJavaScriptKernelVfsInitCode };
