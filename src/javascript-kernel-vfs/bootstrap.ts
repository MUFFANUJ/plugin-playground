import typeScriptSource from '!!raw-loader!typescript/lib/typescript.js';
import typeScriptVfsGlobalsSource from '!!raw-loader!@typescript/vfs/dist/vfs.globals.js';

declare const require: {
  context(
    directory: string,
    useSubdirectories: boolean,
    regExp: RegExp
  ): {
    keys(): string[];
    (id: string): string | { default: string };
  };
};

export function createJavaScriptKernelVfsInitCode(): string {
  // Collect bundled TypeScript lib declaration files (lib*.d.ts) as raw text
  // so the kernel can create virtual file maps fully offline.
  const typeScriptLibContext = require.context(
    '!!raw-loader!typescript/lib',
    false,
    /^\.\/lib\..*\.d\.ts$/
  );
  const bundledTypeScriptLibFiles = Object.fromEntries(
    typeScriptLibContext.keys().flatMap((key): [string, string][] => {
      const moduleValue = typeScriptLibContext(key);
      const content =
        typeof moduleValue === 'string' ? moduleValue : moduleValue.default;
      if (typeof content !== 'string') {
        return [];
      }
      const fileName = key.replace(/^\.\//, '');
      return [[`/${fileName}`, content]];
    })
  ) as Record<string, string>;

  return `(() => {
  // Guard for a compatible TypeScript compiler API object.
  const hasUsableTypeScript = candidate =>
    !!candidate &&
    typeof candidate === "object" &&
    typeof candidate.createProgram === "function" &&
    typeof candidate.createSourceFile === "function" &&
    typeof candidate.ScriptTarget === "object";
  // Guard for a compatible @typescript/vfs API object.
  const hasUsableTypeScriptVfs = candidate =>
    !!candidate &&
    typeof candidate === "object" &&
    typeof candidate.createSystem === "function" &&
    typeof candidate.createVirtualTypeScriptEnvironment === "function";

  // Step 1: ensure globalThis.ts is present and usable.
  if (!hasUsableTypeScript(globalThis.ts)) {
    const tsSource = ${JSON.stringify(typeScriptSource)};
    (0, eval)(
      tsSource +
        '\\n;globalThis.ts = typeof ts !== "undefined" ? ts : globalThis.ts;'
    );
  }
  if (!hasUsableTypeScript(globalThis.ts)) {
    throw new Error(
      'Plugin Playground VFS bootstrap failed: bundled TypeScript did not initialize.'
    );
  }
  // Step 2: expose stable TypeScript aliases expected by kernel examples.
  if (!globalThis.typescript) {
    globalThis.typescript = globalThis.ts;
  }
  if (!globalThis.vfsBundledTs) {
    globalThis.vfsBundledTs = globalThis.ts;
  }
  // Step 3: publish bundled declaration libs and a helper map factory.
  if (!globalThis.vfsBundledLibFiles) {
    globalThis.vfsBundledLibFiles = ${JSON.stringify(bundledTypeScriptLibFiles)};
  }
  if (!globalThis.vfsCreateDefaultMapFromBundledLibs) {
    globalThis.vfsCreateDefaultMapFromBundledLibs = () =>
      new Map(Object.entries(globalThis.vfsBundledLibFiles));
  }
  // Step 4: ensure @typescript/vfs globals are loaded and compatible.
  if (!hasUsableTypeScriptVfs(globalThis.tsvfs)) {
    const source = ${JSON.stringify(typeScriptVfsGlobalsSource)};
    (0, eval)(source);
  }
  if (!hasUsableTypeScriptVfs(globalThis.tsvfs)) {
    throw new Error(
      'Plugin Playground VFS bootstrap failed: bundled @typescript/vfs did not initialize.'
    );
  }
  if (!hasUsableTypeScriptVfs(globalThis.vfs)) {
    globalThis.vfs = globalThis.tsvfs;
  }
  if (!hasUsableTypeScriptVfs(globalThis.vfs)) {
    throw new Error(
      'Plugin Playground VFS bootstrap failed: global vfs is not compatible with @typescript/vfs.'
    );
  }
})();`;
}
