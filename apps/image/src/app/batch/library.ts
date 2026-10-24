/**
 * The recipe library (PRODUCT-PLAN 6.9): app-wide like the swatch library, not document state, so it makes no undo
 * steps. Persisted in local storage (in the Tauri shell that lives in the app's data directory); a storage failure
 * keeps the library in memory and says so once. Entries were validated when they were saved or imported; loading only
 * checks their shape, so the recipe engine stays out of the start chunk (it validates again before applying).
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Recipe } from '../../core/recipes';
import type { EditorController } from '../../ui/controller';

const KEY = 'fernwork.recipes';

export interface RecipeLibraryState {
  readonly recipes: readonly Recipe[];
  /** The recipe last saved or applied (preselected in File › Batch…). */
  readonly lastUsedId: string | null;
  /** Set when the library could not be written to storage. */
  readonly storageFailed: boolean;
  /** Whether the Recipes panel is open (Layer › Apply Recipe › Manage Recipes…). */
  readonly panelOpen: boolean;
}

function load(): { recipes: Recipe[]; lastUsedId: string | null } {
  try {
    const text = globalThis.localStorage?.getItem(KEY);
    if (!text) return { recipes: [], lastUsedId: null };
    const value = JSON.parse(text) as { recipes?: unknown[]; lastUsedId?: unknown };
    const recipes: Recipe[] = [];
    for (const candidate of Array.isArray(value.recipes) ? value.recipes : []) {
      const entry = candidate as Partial<Recipe> | null;
      // A damaged entry is dropped, the rest stays.
      if (entry && entry.format === 'fernwork-recipe' && entry.version === 1 && typeof entry.id === 'string'
        && typeof entry.name === 'string' && Array.isArray(entry.steps)) recipes.push(entry as Recipe);
    }
    return { recipes, lastUsedId: typeof value.lastUsedId === 'string' ? value.lastUsedId : null };
  } catch { return { recipes: [], lastUsedId: null }; }
}

const stores = new WeakMap<EditorController, StoreApi<RecipeLibraryState>>();

export function recipeLibrary(controller: EditorController): StoreApi<RecipeLibraryState> {
  let store = stores.get(controller);
  if (store) return store;
  store = createStore<RecipeLibraryState>(() => ({ ...load(), storageFailed: false, panelOpen: false }));
  const persisted = store;
  store.subscribe((state, previous) => {
    if (state.recipes === previous.recipes && state.lastUsedId === previous.lastUsedId) return;
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify({ recipes: state.recipes, lastUsedId: state.lastUsedId })); }
    catch { if (!state.storageFailed) persisted.setState({ storageFailed: true }); }
  });
  stores.set(controller, store);
  return store;
}

export function addRecipe(controller: EditorController, recipe: Recipe): void {
  const store = recipeLibrary(controller);
  store.setState({ recipes: [...store.getState().recipes.filter((r) => r.id !== recipe.id), recipe], lastUsedId: recipe.id });
}

export function renameRecipe(controller: EditorController, id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const store = recipeLibrary(controller);
  store.setState({ recipes: store.getState().recipes.map((recipe) => (recipe.id === id ? { ...recipe, name: trimmed } : recipe)) });
}

export function deleteRecipe(controller: EditorController, id: string): void {
  const store = recipeLibrary(controller), state = store.getState();
  store.setState({ recipes: state.recipes.filter((recipe) => recipe.id !== id), lastUsedId: state.lastUsedId === id ? null : state.lastUsedId });
}

export function showRecipesPanel(controller: EditorController, open = true): void {
  recipeLibrary(controller).setState({ panelOpen: open });
}

export function markRecipeUsed(controller: EditorController, id: string): void {
  recipeLibrary(controller).setState({ lastUsedId: id });
}

export function findRecipe(controller: EditorController, id: string | null): Recipe | null {
  return id ? recipeLibrary(controller).getState().recipes.find((recipe) => recipe.id === id) ?? null : null;
}
