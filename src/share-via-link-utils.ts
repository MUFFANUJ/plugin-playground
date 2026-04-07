import { Dialog, showDialog } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { formatFileSize } from '@jupyterlab/filebrowser';
import { Widget } from '@lumino/widgets';

import type { ShareLink } from './share-link';

export interface IFolderShareCandidateFile {
  relativePath: string;
  source: string;
  sizeBytes: number;
}

export interface IFolderShareSelectionResult {
  selectedPaths: string[];
  disableDialogIfAllFilesCanBeIncluded: boolean;
}

class FolderShareSelectionDialogBody
  extends Widget
  implements Dialog.IBodyWidget<string[]>
{
  constructor(
    files: ReadonlyArray<IFolderShareCandidateFile>,
    totalBytes: number
  ) {
    super();
    this.addClass('jp-PluginPlayground-folderShareSelectionDialog');

    const documentRef = this.node.ownerDocument;
    const summary = documentRef.createElement('p');
    summary.classList.add('jp-PluginPlayground-folderShareSelectionSummary');
    summary.textContent =
      `${files.length} selectable file${files.length === 1 ? '' : 's'} ` +
      `(${formatFileSize(totalBytes, 1, 1024)} total).`;
    this.node.appendChild(summary);

    const list = documentRef.createElement('div');
    list.classList.add('jp-PluginPlayground-folderShareSelectionList');

    for (const file of files) {
      const label = documentRef.createElement('label');
      label.classList.add('jp-PluginPlayground-folderShareSelectionRow');

      const checkbox = documentRef.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      label.appendChild(checkbox);

      const text = documentRef.createElement('span');
      text.classList.add('jp-PluginPlayground-folderShareSelectionPath');
      text.textContent =
        `${file.relativePath} (` +
        `${formatFileSize(file.sizeBytes, 1, 1024)})`;
      label.appendChild(text);

      this._checkboxRows.push({
        path: file.relativePath,
        checkbox
      });
      list.appendChild(label);
    }

    this.node.appendChild(list);
  }

  getValue(): string[] {
    return this._checkboxRows
      .filter(row => row.checkbox.checked)
      .map(row => row.path);
  }

  private _checkboxRows: Array<{
    path: string;
    checkbox: HTMLInputElement;
  }> = [];
}

const SHARE_FOLDER_EXCLUDED_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.cur',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp4',
  '.mov',
  '.mkv',
  '.mp3',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.svg',
  '.tar',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
  '.7z'
]);

export function shouldSkipFolderShareEntry(path: string): boolean {
  return SHARE_FOLDER_EXCLUDED_EXTENSIONS.has(
    PathExt.extname(path).toLowerCase()
  );
}

export function buildFolderSharePayload(
  folderPath: string,
  files: ReadonlyArray<IFolderShareCandidateFile>
): ShareLink.ISharedPluginFolderPayload {
  const fileMap: Record<string, string> = Object.create(null);
  const sortedFiles = [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
  for (const file of sortedFiles) {
    fileMap[file.relativePath] = file.source;
  }

  const rootName = PathExt.basename(folderPath) || 'shared-plugin';

  return {
    version: 1,
    kind: 'folder',
    rootName,
    files: fileMap
  };
}

export async function selectFolderSharePaths(
  files: ReadonlyArray<IFolderShareCandidateFile>,
  includeDisableDialogCheckbox = false
): Promise<IFolderShareSelectionResult | null> {
  const sortedFiles = [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
  const totalBytes = sortedFiles.reduce(
    (total, file) => total + file.sizeBytes,
    0
  );

  const selectionResult = await showDialog<string[]>({
    title: 'Select Files to Share',
    body: new FolderShareSelectionDialogBody(sortedFiles, totalBytes),
    buttons: [
      Dialog.cancelButton(),
      Dialog.okButton({ label: 'Share Selected Files' })
    ],
    focusNodeSelector: 'input[type="checkbox"]',
    checkbox: includeDisableDialogCheckbox
      ? {
          label: 'Do not ask me again if all files can be included'
        }
      : null
  });
  if (!selectionResult.button.accept) {
    return null;
  }

  return {
    selectedPaths: selectionResult.value ?? [],
    disableDialogIfAllFilesCanBeIncluded: selectionResult.isChecked === true
  };
}
