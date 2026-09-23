/**
 * Project tabs, ported from Document/ProjectWorkspace.swift. Each tab owns one session with its
 * own document and undo history.
 */

import { uuid } from './ids';
import { EditorSession, type SessionServices } from './session';

export class ProjectTab {
  readonly id = uuid();
  readonly session: EditorSession;
  readonly defaultName: string;
  constructor(name: string, services: SessionServices | null) {
    this.defaultName = name;
    this.session = new EditorSession(services ?? undefined);
  }
  get title(): string { return this.session.projectName ?? this.defaultName; }
}

export class ProjectWorkspace {
  tabs: ProjectTab[] = [];
  selectedId: string;
  isManaging = false;
  private nextNumber = 2;
  private listeners = new Set<() => void>();
  private detach = new Map<string, () => void>();
  private revisionValue = 0;
  readonly services: SessionServices | null;

  constructor(services: SessionServices | null = null) {
    this.services = services;
    const first = new ProjectTab('Untitled', services);
    this.tabs = [first];
    this.selectedId = first.id;
    this.watch(first);
  }

  get revision(): number { return this.revisionValue; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void {
    this.revisionValue++;
    for (const listener of [...this.listeners]) listener();
  }
  private watch(tab: ProjectTab): void {
    // Tab titles and unsaved dots follow their sessions.
    this.detach.set(tab.id, tab.session.subscribe((kind) => { if (kind !== 'view') this.notify(); }));
  }

  get current(): ProjectTab { return this.tabs.find((t) => t.id === this.selectedId) ?? this.tabs[0]!; }

  get canSwitch(): boolean {
    const s = this.current.session;
    return !this.isManaging && s.canStartProjectOperation && s.transformEdit?.floating === undefined;
  }

  addTab(reuseEmpty = true): ProjectTab {
    if (reuseEmpty && this.tabs.length === 1 && this.current.session.document === null) return this.current;
    const tab = new ProjectTab(`Untitled ${this.nextNumber++}`, this.services);
    this.watch(tab);
    this.tabs = [...this.tabs, tab];
    this.selectedId = tab.id;
    this.notify();
    return tab;
  }

  select(id: string): void {
    if (id === this.selectedId || !this.canSwitch || !this.tabs.some((t) => t.id === id)) return;
    this.current.session.commitTransform();
    this.selectedId = id;
    this.notify();
  }

  newCanvas(): ProjectTab | null {
    if (!this.canSwitch) return null;
    this.current.session.commitTransform();
    return this.addTab(false);
  }

  /** Adds a loaded tab; replaces the lone empty tab like upstream `loadProject`. */
  adopt(tab: ProjectTab): void {
    this.watch(tab);
    if (this.tabs.length === 1 && this.current.session.document === null) {
      const lone = this.tabs[0]!;
      this.detach.get(lone.id)?.();
      this.tabs = [];
    }
    this.tabs = [...this.tabs, tab];
    this.selectedId = tab.id;
    this.notify();
  }

  createTab(name: string): ProjectTab { return new ProjectTab(name, this.services); }

  removeTab(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    this.detach.get(id)?.();
    this.detach.delete(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (!this.tabs.length) {
      const tab = new ProjectTab(`Untitled ${this.nextNumber++}`, this.services);
      this.watch(tab);
      this.tabs = [tab];
      this.selectedId = tab.id;
    } else if (this.selectedId === id) this.selectedId = this.tabs[Math.min(index, this.tabs.length - 1)]!.id;
    this.notify();
  }

  destroy(): void {
    for (const off of this.detach.values()) off();
    this.detach.clear();
    this.listeners.clear();
  }
}
