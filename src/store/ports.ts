import type { DataAdapter, FileManager, MetadataCache, Vault } from 'obsidian';

/** The slice of Obsidian's App the store uses. Picked from the real types, so `App` satisfies it. */
export interface StoreApp {
  vault: Pick<Vault, 'getMarkdownFiles' | 'getFileByPath' | 'cachedRead' | 'process' | 'on' | 'offref'> & {
    adapter: Pick<DataAdapter, 'exists' | 'read' | 'write' | 'rename' | 'remove' | 'mkdir'>;
  };
  fileManager: Pick<FileManager, 'processFrontMatter'>;
  metadataCache: Pick<MetadataCache, 'getFileCache' | 'getFirstLinkpathDest' | 'fileToLinktext' | 'on' | 'offref'>;
}

/** Something in a note or state.json the store skipped. Never fatal. */
export interface StoreWarning {
  /** Note path, or the state file's. */
  path: string;
  field?: string;
  msg: string;
}
