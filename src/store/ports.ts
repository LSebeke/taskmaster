import type { DataAdapter, FileManager, MetadataCache, Vault } from 'obsidian';

/** The slice of Obsidian's App the store uses. Picked from the real types, so `App` satisfies it. */
export interface StoreApp {
  vault: Pick<Vault, 'getMarkdownFiles' | 'getFileByPath' | 'getFolderByPath' | 'getAbstractFileByPath' | 'cachedRead' | 'read' | 'create' | 'createFolder' | 'process' | 'on' | 'offref'> & {
    adapter: Pick<DataAdapter, 'exists' | 'read' | 'write' | 'rename' | 'remove' | 'mkdir'>;
  };
  fileManager: Pick<FileManager, 'processFrontMatter' | 'renameFile' | 'trashFile' | 'getNewFileParent'>;
  metadataCache: Pick<MetadataCache, 'resolvedLinks' | 'getFileCache' | 'getFirstLinkpathDest' | 'fileToLinktext' | 'on' | 'offref'>;
}

/** Where a path is after `from` became `to`, for a note or a folder. */
export const movedPath = (path: string, from: string, to: string) => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);

/** Something in a note or state.json the store skipped. Never fatal. */
export interface StoreWarning {
  /** Note path, or the state file's. */
  path: string;
  field?: string;
  msg: string;
}
