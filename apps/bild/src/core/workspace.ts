/**
 * Project tabs, ported from Document/ProjectWorkspace.swift. Each tab owns one session with its
 * own document and undo history.
 */

import { uuid } from './ids';
import { descendantIds, MAX_PIXELS, type Layer } from './document';
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

  /**
   * ProjectWorkspace.copyLayer: a layer (with its folder contents) copied into another tab or a new
   * one, centred at `point` or the canvas centre. Live masks whose source stays behind are baked into
   * pixels (adjustments just lose the link); ids are fresh; one undo step in the destination.
   */
  async copyLayer(id: string, destination: string | null, point: { x: number; y: number } | null = null): Promise<string | null> {
    const source = this.tabs.find((t) => t.session.document?.layers.some((l) => l.id === id));
    if (!this.canSwitch || !source || !source.session.canEditLayers || source.id === destination) return null;
    const sourceDocument = source.session.document!;
    let target: ProjectTab;
    if (destination) {
      const existing = this.tabs.find((t) => t.id === destination);
      if (!existing || !existing.session.canStartProjectOperation) return null;
      target = existing;
    } else target = this.addTab(false);
    if (target.session.document && !target.session.canEditLayers) return null;
    const included = new Set([id, ...descendantIds(sourceDocument.layers, id)]);
    const copied = sourceDocument.layers.filter((l) => included.has(l.id)).map((l) => ({ ...l }));
    const pixels = (layers: readonly Layer[]) => layers.reduce((n, l) => n + (l.raster ? l.raster.width * l.raster.height : 0), 0);
    if (pixels(target.session.document?.layers ?? []) + pixels(copied) > MAX_PIXELS) {
      target.session.errorMessage = 'The copied layers exceed this project’s 100-megapixel limit.';
      target.session.notify('ui');
      return null;
    }
    for (let i = 0; i < copied.length; i++) {
      const layer = copied[i]!;
      if (!layer.maskSourceId || included.has(layer.maskSourceId)) continue;
      if (layer.adjustment) { copied[i] = { ...layer, maskSourceId: null }; continue; }
      const baked = await this.services?.bakeLiveMask(sourceDocument, layer.id);
      copied[i] = { ...layer, raster: baked ?? layer.raster, maskSourceId: null };
    }
    const mapping = new Map(copied.map((l) => [l.id, uuid()]));
    const size = target.session.document ?? sourceDocument;
    const anchorLayer = copied.find((l) => l.id === id);
    const anchor = anchorLayer ? { x: anchorLayer.transform.origin.x + anchorLayer.transform.size.width / 2, y: anchorLayer.transform.origin.y + anchorLayer.transform.size.height / 2 }
      : { x: sourceDocument.width / 2, y: sourceDocument.height / 2 };
    const centre = point ?? { x: size.width / 2, y: size.height / 2 };
    const dx = centre.x - anchor.x, dy = centre.y - anchor.y;
    const layers: Layer[] = copied.map((layer) => ({
      ...layer,
      id: mapping.get(layer.id)!,
      parentId: layer.parentId ? mapping.get(layer.parentId) ?? null : null,
      maskSourceId: layer.maskSourceId ? mapping.get(layer.maskSourceId) ?? null : null,
      transform: { ...layer.transform, origin: { x: layer.transform.origin.x + dx, y: layer.transform.origin.y + dy } },
      mask: layer.mask ? { ...layer.mask, placement: layer.mask.placement
        ? { ...layer.mask.placement, origin: { x: layer.mask.placement.origin.x + dx, y: layer.mask.placement.origin.y + dy } } : null } : null,
    }));
    const session = target.session;
    session.beginEdit('Copy Layers from Project');
    if (!session.document) session.createDocument(sourceDocument.width, sourceDocument.height);
    session.replaceDocument({ ...session.document!, layers: [...session.document!.layers, ...layers] });
    session.setActiveLayer(mapping.get(id) ?? null);
    session.endEdit();
    this.selectedId = target.id;
    this.notify();
    return mapping.get(id) ?? null;
  }

  destroy(): void {
    for (const off of this.detach.values()) off();
    this.detach.clear();
    this.listeners.clear();
  }
}
