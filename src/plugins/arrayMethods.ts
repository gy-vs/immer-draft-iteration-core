import {
	ProxyArrayState,
	PluginArrayMethods,
	DRAFT_STATE,
	loadPlugin,
	latest,
	prepareCopy,
	markChanged,
	handleCrossReference,
	isDraft,
	isDraftable,
	is,
	has,
	ArchType
} from "../internal"

/**
 * The `enableArrayMethods` plugin intercepts the mutating and read-only
 * Array.prototype methods of an array draft *inside the proxy `get` trap*,
 * so that:
 *
 * - mutating methods (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`,
 *   `reverse`) operate directly on `state.copy_`. Without the plugin the
 *   native methods draft every index they touch on the proxy (all of them
 *   for e.g. `reverse`/`sort`); the plugin never creates those per-index
 *   proxies. `assigned_`, `length`, cross-reference cleanup callbacks and
 *   therefore the generated patches stay identical to what the generic
 *   set/get traps would have produced.
 *
 * - read-only methods (`filter`, `slice`, `concat`, `flat`, `find`,
 *   `findLast`, `findIndex`, `findLastIndex`, `some`, `every`, `indexOf`,
 *   `includes`, `join`) invoke user callbacks with the *raw* values of the
 *   draft (never per-index proxies), and draft only the elements that end
 *   up in the result / are "hit", so that mutating a hit element still
 *   works exactly as without the plugin.
 *
 * `map`, `flatMap`, `reduce`, `reduceRight` and `forEach` are intentionally
 * *not* intercepted: those hand every element to user code, and upstream
 * Immer deliberately keeps drafting those through the generic trap so every
 * element is observable as a draft.
 */
export function enableArrayMethods() {
	/**
	 * Resolves an element stored in the draft's base/copy to the raw value
	 * a user callback should observe: if it is a draft, hand out its current
	 * (possibly modified) backing value instead of the proxy.
	 */
	function resolveRaw(value: any): any {
		if (isDraft(value)) {
			return latest(value[DRAFT_STATE])
		}
		return value
	}

	/**
	 * True iff `index` is physically present (not a sparse-array hole) in
	 * the draft's current backing array.
	 */
	function present(state: ProxyArrayState, index: number): boolean {
		return has(latest(state), "" + index, ArchType.Array)
	}

	/**
	 * Reads an index through the draft proxy itself, so the value follows
	 * exactly the same drafting rules as `draft[index]` (drafted when it is
	 * an untouched base value, returned raw when it was assigned or is not
	 * draftable). The array's `copy_` is prepared first so the freshly
	 * created child draft is stored in its slot: if that child is later
	 * mutated, finalization can then replace it in this array, while the
	 * array itself stays unmodified (a prepared copy is still `Object.is`
	 * to the base content and pruned back to the base on finalize). Used
	 * for elements that a read-only method exposes to user code, and for
	 * the values returned by the mutating methods.
	 */
	function draftAt(state: ProxyArrayState, index: number): any {
		// Non-draftable values (primitives) come straight out of the generic
		// trap without ever preparing a copy; keep that behavior so a
		// read-only method over a primitive array stays allocation-free.
		const value = latest(state)[index]
		if (!isDraftable(value)) return value
		prepareCopy(state)
		return state.draft_[index]
	}

	/**
	 * Detects whether the native mutating method actually changed anything
	 * compared to `base_` (SameValue comparison, matching the set trap's
	 * `is`): either the length moved, or some index now holds another value.
	 *
	 * This is a single linear read-only scan - deliberately *not* writing one
	 * `assigned_` flag per moved index, which would cost an order of
	 * magnitude more for `reverse`/`sort` on large arrays. Per-index patch
	 * bookkeeping is derived from the same comparison later, lazily, in the
	 * patch generator (`arrayMethodMutated_`).
	 *
	 * The result doubles as the no-op check that preserves base identity for
	 * mutations like `[1, 2, 1].reverse()`.
	 */
	function detectArrayMutation(state: ProxyArrayState): boolean {
		const {base_, copy_} = state
		const baseLength = base_.length
		const copyLength = copy_!.length
		if (copyLength !== baseLength) return true
		// Every mutating method we intercept writes each surviving slot at
		// most once (reverse/sort pair swaps, shift/unshift/splice moves),
		// so we can replay the set trap's per-write bail rule against the
		// final layout: a write is ignored iff the new value is the same
		// value already there and it is not an explicit `undefined` landing
		// in a former sparse hole (the set trap's
		// `value !== undefined || has(base_, prop)` condition). This keeps
		// base identity for e.g. `[1, 2, 1].reverse()` while still detecting
		// hole/undefined rearrangements the generic trap would record.
		for (let i = 0; i < copyLength; i++) {
			const value = copy_![i]
			if (
				!is(value, base_[i]) ||
				(value === undefined &&
					has(copy_!, "" + i, ArchType.Array) &&
					!has(base_, "" + i, ArchType.Array))
			) {
				return true
			}
		}
		return false
	}

	/**
	 * Discards the prepared copy again. This restores a draft that never
	 * got modified (e.g. reversing an array that equals its own reverse),
	 * so `produce` keeps returning the base by identity, exactly like the
	 * generic set trap does for assignments that don't change anything.
	 *
	 * Only valid when the state was unmodified before the method ran and the
	 * method inserted nothing, so no child drafts could have been created
	 * against the discarded copy.
	 */
	function discardCopy(state: ProxyArrayState) {
		state.copy_ = null
		state.assigned_ = undefined
		state.arrayMethodMutated_ = false
	}

	/**
	 * Runs the native mutating `action` on `copy_` while keeping the draft
	 * bookkeeping consistent with the generic set trap:
	 *
	 * 1. `prepareCopy` first, so `copy_` exists before any value is touched,
	 *    just like a regular indexed assignment would arrange.
	 * 2. The native method mutates `copy_` directly - no per-index proxies.
	 * 3. A linear diff decides whether anything actually changed; if not,
	 *    and the state was previously unmodified, the copy is discarded and
	 *    the draft keeps resolving to the frozen base.
	 * 4. Otherwise `arrayMethodMutated_` is flagged and `markChanged`
	 *    propagates to parent states; every inserted argument then gets the
	 *    same cross-reference cleanup registration as the set trap performs
	 *    (`handleCrossReference`), so drafts / objects holding drafts that
	 *    were inserted into the array are finalized in place and keep one
	 *    shared identity.
	 */
	function commitMutation(
		state: ProxyArrayState,
		action: (copy: any[]) => any,
		inserted?: any[],
		insertedStart?: number
	): any {
		const wasUnmodified = !state.modified_
		prepareCopy(state)
		const result = action(state.copy_!)
		if (!detectArrayMutation(state) && wasUnmodified) {
			discardCopy(state)
		} else {
			state.arrayMethodMutated_ = true
			markChanged(state)
			if (inserted) {
				for (let j = 0; j < inserted.length; j++) {
					const value = inserted[j]
					if (isDraft(value) || isDraftable(value)) {
						handleCrossReference(state, insertedStart! + j, value)
					}
				}
			}
		}
		return result
	}

	// #region Mutating methods

	function push(state: ProxyArrayState, args: any[]): number {
		if (!args.length) return latest(state).length
		const start = latest(state).length
		return commitMutation(
			state,
			copy => Array.prototype.push.apply(copy, args),
			args,
			start
		)
	}

	function unshift(state: ProxyArrayState, args: any[]): number {
		if (!args.length) return latest(state).length
		return commitMutation(
			state,
			copy => Array.prototype.unshift.apply(copy, args),
			args,
			0
		)
	}

	function pop(state: ProxyArrayState): any {
		const source = latest(state)
		const length = source.length
		if (!length) return undefined
		// Read the removed element through the proxy *before* shrinking, the
		// same order native `pop` performs its `Get` before resetting
		// `length`: draftable base values come back as drafts, assigned raw
		// values come back raw. Never touch the (possibly frozen) base with
		// the native method for the empty case.
		const removed = draftAt(state, length - 1)
		commitMutation(state, copy => Array.prototype.pop.call(copy))
		return removed
	}

	function shift(state: ProxyArrayState): any {
		if (!latest(state).length) return undefined
		const removed = draftAt(state, 0)
		commitMutation(state, copy => Array.prototype.shift.call(copy))
		return removed
	}

	function splice(state: ProxyArrayState, args: any[]): any[] {
		const source = latest(state)
		const length = source.length
		let start = toIntegerOrInfinity(args[0])
		if (start === Infinity) start = length
		else if (start < 0) start = Math.max(length + start, 0)
		else start = Math.min(start, length)

		let deleteCount: number
		if (args.length < 2) {
			deleteCount = length - start
		} else if (args[1] === undefined) {
			deleteCount = 0
		} else {
			// Per spec: clamp the second argument to [0, length - start]
			deleteCount = Math.min(
				Math.max(toIntegerOrInfinity(args[1]), 0),
				length - start
			)
		}

		const inserted = args.slice(2)

		// A splice that neither removes nor inserts anything is a no-op and
		// must leave the draft (and its identity) untouched.
		if (!deleteCount && !inserted.length) return []

		// Capture the removed elements before the native rearrangement, via
		// the proxy, so draftable values are returned as drafts.
		const removed: any[] = []
		for (let i = 0; i < deleteCount; i++) {
			removed.push(
				present(state, start + i) ? draftAt(state, start + i) : undefined
			)
		}

		commitMutation(
			state,
			copy => (Array.prototype.splice as any).apply(copy, args),
			inserted,
			start
		)
		return removed
	}

	function sort(state: ProxyArrayState, args: any[]): any {
		// Validate the comparator before any short-circuit, exactly like
		// the native method (which throws for a non-function, non-undefined
		// comparefn even on an empty array).
		const compareFn = args[0]
		if (compareFn !== undefined && typeof compareFn !== "function") {
			Array.prototype.sort.call(latest(state), compareFn)
		}
		if (!latest(state).length) return state.draft_
		// The comparator observes raw values rather than per-index drafts,
		// which is the whole performance point of the plugin. `undefined`
		// selects the native default ordering.
		const nativeArg =
			typeof compareFn === "function"
				? (a: any, b: any) => compareFn(resolveRaw(a), resolveRaw(b))
				: compareFn
		commitMutation(state, copy =>
			Array.prototype.sort.call(copy, nativeArg as any)
		)
		return state.draft_
	}

	function reverse(state: ProxyArrayState): any {
		if (!latest(state).length) return state.draft_
		commitMutation(state, copy => Array.prototype.reverse.call(copy))
		return state.draft_
	}

	// #endregion

	// #region Read-only methods
	//
	// These never prepare a copy and never mark the state modified. Their
	// user callbacks receive raw values (so no per-index proxies are
	// created); only elements that end up in the returned result are
	// drafted, which is enough to keep "find the item, then mutate it"
	// working exactly as without the plugin. Sparse-array holes are skipped
	// for callbacks and preserved in the results, matching the native
	// methods' HasProperty-driven behavior through the proxy.

	/**
	 * Delegates a callback-validation failure to the native method on the
	 * raw backing array, so the engine throws its own canonical TypeError
	 * ("... is not a function") at the user's call site instead of a
	 * divergent message produced by invoking the bad value ourselves.
	 */
	function rejectNonFunctionCallback(
		source: any[],
		nativeMethod: string,
		args: any[]
	): never {
		;(Array.prototype as any)[nativeMethod].apply(source, args)
		// Unreachable: the native call always throws for non-callable
		// callbacks before it starts iterating.
		throw new TypeError(`${nativeMethod} requires a callable argument`)
	}

	function wrapCallback(state: ProxyArrayState, callback: any, thisArg: any) {
		// Binds the user's `thisArg` here; the native call sites below only
		// invoke the wrapper itself, so without this the caller's receiver
		// would be lost.
		return (value: any, index: number) =>
			callback.call(thisArg, resolveRaw(value), index, state.draft_)
	}

	function filter(state: ProxyArrayState, args: any[]): any[] {
		const source = latest(state)
		if (typeof args[0] !== "function")
			rejectNonFunctionCallback(source, "filter", args)
		const callback = wrapCallback(state, args[0], args[1])
		const result: any[] = []
		for (let i = 0; i < source.length; i++) {
			if (present(state, i) && callback(source[i], i)) {
				// Only hits become drafts - non-matching elements never
				// touch the proxy.
				result.push(draftAt(state, i))
			}
		}
		return result
	}

	function find(state: ProxyArrayState, args: any[]): any {
		const source = latest(state)
		if (typeof args[0] !== "function")
			rejectNonFunctionCallback(source, "find", args)
		const callback = wrapCallback(state, args[0], args[1])
		for (let i = 0; i < source.length; i++) {
			if (present(state, i) && callback(source[i], i)) {
				return draftAt(state, i)
			}
		}
		return undefined
	}

	function findLast(state: ProxyArrayState, args: any[]): any {
		const source = latest(state)
		if (typeof args[0] !== "function")
			rejectNonFunctionCallback(source, "findLast", args)
		const callback = wrapCallback(state, args[0], args[1])
		for (let i = source.length - 1; i >= 0; i--) {
			if (present(state, i) && callback(source[i], i)) {
				return draftAt(state, i)
			}
		}
		return undefined
	}

	function findIndex(state: ProxyArrayState, args: any[]): number {
		const source = latest(state)
		if (typeof args[0] !== "function")
			rejectNonFunctionCallback(source, "findIndex", args)
		const callback = wrapCallback(state, args[0], args[1])
		for (let i = 0; i < source.length; i++) {
			if (present(state, i) && callback(source[i], i)) return i
		}
		return -1
	}

	function findLastIndex(state: ProxyArrayState, args: any[]): number {
		const source = latest(state)
		if (typeof args[0] !== "function")
			rejectNonFunctionCallback(source, "findLastIndex", args)
		const callback = wrapCallback(state, args[0], args[1])
		for (let i = source.length - 1; i >= 0; i--) {
			if (present(state, i) && callback(source[i], i)) return i
		}
		return -1
	}

	function some(state: ProxyArrayState, args: any[]): boolean {
		const source = latest(state)
		if (typeof args[0] !== "function")
			rejectNonFunctionCallback(source, "some", args)
		const callback = wrapCallback(state, args[0], args[1])
		for (let i = 0; i < source.length; i++) {
			if (present(state, i) && callback(source[i], i)) {
				return true
			}
		}
		return false
	}

	function every(state: ProxyArrayState, args: any[]): boolean {
		const source = latest(state)
		if (typeof args[0] !== "function")
			rejectNonFunctionCallback(source, "every", args)
		const callback = wrapCallback(state, args[0], args[1])
		for (let i = 0; i < source.length; i++) {
			if (present(state, i) && !callback(source[i], i)) {
				return false
			}
		}
		return true
	}

	function normalizeFromIndex(fromIndex: any, length: number): number {
		let index = toIntegerOrInfinity(fromIndex)
		if (index === Infinity) return length
		if (index === -Infinity) return 0
		if (index < 0) index = Math.max(length + index, 0)
		return index
	}

	function indexOf(state: ProxyArrayState, args: any[]): number {
		const source = latest(state)
		const searched = resolveRaw(args[0])
		const from =
			args.length > 1 ? normalizeFromIndex(args[1], source.length) : 0
		// Strict equality (not Object.is): NaN never matches NaN here.
		for (let i = from; i < source.length; i++) {
			if (present(state, i) && resolveRaw(source[i]) === searched) return i
		}
		return -1
	}

	function includes(state: ProxyArrayState, args: any[]): boolean {
		const source = latest(state)
		const searched = resolveRaw(args[0])
		const from =
			args.length > 1 ? normalizeFromIndex(args[1], source.length) : 0
		for (let i = from; i < source.length; i++) {
			if (!present(state, i)) continue
			const value = resolveRaw(source[i])
			// SameValueZero: NaN matches NaN.
			if (value === searched || (value !== value && searched !== searched)) {
				return true
			}
		}
		return false
	}

	function slice(state: ProxyArrayState, args: any[]): any[] {
		const source = latest(state)
		const length = source.length
		let start = toIntegerOrInfinity(args[0]) || 0
		if (start === Infinity) start = length
		else if (start < 0) start = Math.max(length + start, 0)
		else start = Math.min(start, length)

		let end: number
		if (args.length < 2 || args[1] === undefined) {
			end = length
		} else {
			end = toIntegerOrInfinity(args[1])
			if (end === Infinity) end = length
			else if (end < 0) end = Math.max(length + end, 0)
			else end = Math.min(end, length)
		}

		// Assign positionally (source index == result index within the
		// slice) instead of pushing so sparse-array holes stay holes; every
		// present included element is drafted, as any of them could be
		// mutated by the caller afterwards.
		const result: any[] = []
		for (let i = start; i < end; i++) {
			if (present(state, i)) result[i - start] = draftAt(state, i)
		}
		result.length = end - start
		return result
	}

	function concat(state: ProxyArrayState, args: any[]): any[] {
		const result: any[] = []
		// Elements reached through the draft receiver are drafts (read via
		// the proxy); elements coming from the caller's arguments are passed
		// through raw - exactly the un-plugged behavior.
		appendConcatElements(result, state.draft_)
		for (const arg of args) appendConcatElements(result, arg)
		return result
	}

	function appendConcatElements(result: any[], value: any) {
		if (!isConcatSpreadable(value)) {
			result.push(value)
			return
		}
		// Assign by absolute index instead of pushing so sparse-array holes
		// remain holes; present entries read through a draft receiver get
		// drafted, while raw spreadables are iterated raw.
		const startLength = result.length
		let target = startLength
		for (let i = 0; i < value.length; i++) {
			if (has(value, "" + i, ArchType.Array)) result[target] = value[i]
			target++
		}
		result.length = target
	}

	function isConcatSpreadable(value: any): boolean {
		if (value === null || typeof value !== "object") return false
		const spreadable = value[Symbol.isConcatSpreadable]
		if (spreadable !== undefined) return !!spreadable
		return Array.isArray(value)
	}

	function flat(state: ProxyArrayState, args: any[]): any[] {
		const depthArg =
			args.length === 0 || args[0] === undefined ? 1 : Number(args[0])
		const depth = depthArg === Infinity ? Infinity : depthArg
		const result: any[] = []
		flattenIntoArray(result, state.draft_, depth)
		return result
	}

	function flattenIntoArray(result: any[], array: any, depth: number) {
		for (let i = 0; i < array.length; i++) {
			// Sparse holes are skipped at every level, matching native flat's
			// HasProperty-driven FlattenIntoArray semantics.
			if (!has(array, "" + i, ArchType.Array)) continue
			const value = array[i]
			if (depth > 0 && Array.isArray(value)) {
				// Nested arrays reached through the draft are themselves
				// drafts (read through the proxy); nested arrays reached
				// through raw inserted values stay raw.
				flattenIntoArray(
					result,
					value,
					depth === Infinity ? Infinity : depth - 1
				)
			} else {
				result.push(value)
			}
		}
	}

	function join(state: ProxyArrayState, args: any[]): string {
		// Native join on the raw backing array produces the same string and
		// avoids drafting every element for string coercion; holes and
		// undefined are handled natively.
		return Array.prototype.join.apply(latest(state), args as any)
	}

	// #endregion

	const mutatingMethods: {
		[key: string]: (state: ProxyArrayState, args: any[]) => any
		// Null prototype: a plain object would resolve unrelated property
		// names inherited from Object.prototype ("constructor", "__proto__",
		// "toString", ...) to truthy values and make us intercept them.
	} = Object.assign(Object.create(null), {
		push,
		pop,
		shift,
		unshift,
		splice,
		sort,
		reverse
	})

	const readOnlyMethods: {
		[key: string]: (state: ProxyArrayState, args: any[]) => any
	} = Object.assign(Object.create(null), {
		filter,
		slice,
		concat,
		flat,
		find,
		findLast,
		findIndex,
		findLastIndex,
		some,
		every,
		indexOf,
		includes,
		join
	})

	// Bound method functions are cached per draft state: the proxy `get`
	// trap is hit on every `draft.items.push(...)` access, and allocating a
	// closure there would defeat the per-index allocation savings.
	const boundMethods: WeakMap<
		ProxyArrayState,
		Map<string, (...args: any[]) => any>
	> = new WeakMap()

	function getArrayMethod_(
		state: ProxyArrayState,
		prop: PropertyKey
	): ((...args: any[]) => any) | undefined {
		if (typeof prop !== "string") return undefined
		const handler = mutatingMethods[prop] || readOnlyMethods[prop]
		if (!handler) return undefined
		// A user-assigned own property with a method name (e.g.
		// `draft.items.push = something`) keeps precedence over the
		// prototype method, exactly as without the plugin.
		if (has(latest(state), prop, ArchType.Array)) return undefined

		let perState = boundMethods.get(state)
		if (!perState) {
			perState = new Map()
			boundMethods.set(state, perState)
		}
		let bound = perState.get(prop)
		if (!bound) {
			bound = function(this: any, ...args: any[]) {
				// Errors thrown by native methods or user callbacks are
				// left untouched so they surface at the exact call site.
				return handler.call(this, state, args)
			}
			perState.set(prop, bound)
		}
		return bound
	}

	function toIntegerOrInfinity(value: any): number {
		const number = Number(value)
		if (isNaN(number) || number === 0) return 0
		if (number === Infinity) return Infinity
		if (number === -Infinity) return -Infinity
		return number < 0 ? Math.ceil(number) : Math.floor(number)
	}

	loadPlugin(PluginArrayMethods, {getArrayMethod_})
}
