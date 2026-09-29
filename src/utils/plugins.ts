import type {ProxyArrayState} from "../core/proxy"
import {
	ImmerState,
	Patch,
	Drafted,
	ImmerBaseState,
	AnyMap,
	AnySet,
	ArchType,
	die,
	ImmerScope
} from "../internal"

export const PluginMapSet = "MapSet"
export const PluginPatches = "Patches"
export const PluginArrayMethods = "ArrayMethods"

export type PatchesPlugin = {
	generatePatches_(
		state: ImmerState,
		basePath: PatchPath,
		rootScope: ImmerScope
	): void
	generateReplacementPatches_(
		base: any,
		replacement: any,
		rootScope: ImmerScope
	): void
	applyPatches_<T>(draft: T, patches: readonly Patch[]): T
	getPath: (state: ImmerState) => PatchPath | null
}

export type MapSetPlugin = {
	proxyMap_<T extends AnyMap>(target: T, parent?: ImmerState): [T, ImmerState]
	proxySet_<T extends AnySet>(target: T, parent?: ImmerState): [T, ImmerState]
	fixSetContents: (state: ImmerState) => void
}

export type ArrayMethodsPlugin = {
	/**
	 * Returns the intercepted implementation of an array method for the
	 * given draft state, or `undefined` if `prop` is not an intercepted
	 * array method (in which case the proxy `get` trap falls back to its
	 * regular, per-index drafting behavior).
	 */
	getArrayMethod_(
		state: ProxyArrayState,
		prop: PropertyKey
	): ((...args: any[]) => any) | undefined
}

/** Plugin utilities */
const plugins: {
	Patches?: PatchesPlugin
	MapSet?: MapSetPlugin
	ArrayMethods?: ArrayMethodsPlugin
} = {}

type Plugins = typeof plugins

export function getPlugin<K extends keyof Plugins>(
	pluginKey: K
): Exclude<Plugins[K], undefined> {
	const plugin = plugins[pluginKey]
	if (!plugin) {
		die(0, pluginKey)
	}
	// @ts-ignore
	return plugin
}

export let isPluginLoaded = <K extends keyof Plugins>(pluginKey: K): boolean =>
	!!plugins[pluginKey]

export function loadPlugin<K extends keyof Plugins>(
	pluginKey: K,
	implementation: Plugins[K]
): void {
	if (!plugins[pluginKey]) plugins[pluginKey] = implementation
}
/** Map / Set plugin */

export interface MapState extends ImmerBaseState {
	type_: ArchType.Map
	copy_: AnyMap | undefined
	base_: AnyMap
	revoked_: boolean
	draft_: Drafted<AnyMap, MapState>
}

export interface SetState extends ImmerBaseState {
	type_: ArchType.Set
	copy_: AnySet | undefined
	base_: AnySet
	drafts_: Map<any, Drafted> // maps the original value to the draft value in the new set
	revoked_: boolean
	draft_: Drafted<AnySet, SetState>
}

/** Patches plugin */

export type PatchPath = (string | number)[]
