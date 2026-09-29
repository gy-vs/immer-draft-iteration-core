import {
	produce,
	produceWithPatches,
	enablePatches,
	enableMapSet,
	enableArrayMethods,
	isDraft,
	setAutoFreeze,
	createDraft,
	finishDraft,
	applyPatches
} from "../src/immer"
import {DRAFT_STATE} from "../src/internal"

enablePatches()
enableMapSet()
enableArrayMethods()

// A factory that mimics the baseline (no array-methods plugin) behavior by
// implementing each mutating method through generic indexed proxy access.
// We verify plugin results against both real semantics and hand-checked
// expectations; the existing upstream test suite (run without/with plugin in
// the same module graph) guards against divergence.

function patchesOf(base: any, recipe: any) {
	return produceWithPatches(base, recipe)
}

describe("enableArrayMethods - mutating methods", () => {
	test("push / pop / shift / unshift results and patches", () => {
		const base = () => ({items: [{x: 1}, {x: 2}, {x: 3}, 30]})

		let [r, p, ip] = patchesOf(base(), (d: any) => {
			d.items.push({x: 9})
		})
		expect(r).toEqual({items: [{x: 1}, {x: 2}, {x: 3}, 30, {x: 9}]})
		expect(p).toEqual([{op: "add", path: ["items", 4], value: {x: 9}}])
		expect(ip).toEqual([{op: "remove", path: ["items", 4]}])
		;[r, p, ip] = patchesOf(base(), (d: any) => {
			d.items.pop()
		})
		expect(r).toEqual({items: [{x: 1}, {x: 2}, {x: 3}]})
		expect(p).toEqual([{op: "remove", path: ["items", 3]}])
		expect(ip).toEqual([{op: "add", path: ["items", 3], value: 30}])
		;[r, p, ip] = patchesOf(base(), (d: any) => {
			d.items.shift()
		})
		expect(r).toEqual({items: [{x: 2}, {x: 3}, 30]})
		expect(p).toEqual([
			{op: "replace", path: ["items", 0], value: {x: 2}},
			{op: "replace", path: ["items", 1], value: {x: 3}},
			{op: "replace", path: ["items", 2], value: 30},
			{op: "remove", path: ["items", 3]}
		])
		expect(ip).toEqual([
			{op: "replace", path: ["items", 0], value: {x: 1}},
			{op: "replace", path: ["items", 1], value: {x: 2}},
			{op: "replace", path: ["items", 2], value: {x: 3}},
			{op: "add", path: ["items", 3], value: 30}
		])
		;[r, p, ip] = patchesOf(base(), (d: any) => {
			d.items.unshift({x: 9})
		})
		expect(r).toEqual({items: [{x: 9}, {x: 1}, {x: 2}, {x: 3}, 30]})
		expect(p).toEqual([
			{op: "replace", path: ["items", 0], value: {x: 9}},
			{op: "replace", path: ["items", 1], value: {x: 1}},
			{op: "replace", path: ["items", 2], value: {x: 2}},
			{op: "replace", path: ["items", 3], value: {x: 3}},
			{op: "add", path: ["items", 4], value: 30}
		])
		expect(ip).toEqual([
			{op: "replace", path: ["items", 0], value: {x: 1}},
			{op: "replace", path: ["items", 1], value: {x: 2}},
			{op: "replace", path: ["items", 2], value: {x: 3}},
			{op: "replace", path: ["items", 3], value: 30},
			{op: "remove", path: ["items", 4]}
		])
	})

	test("splice delete / replace / insert patches", () => {
		const base = () => ({items: [{x: 1}, {x: 2}, {x: 3}, 30]})

		let [r, p, ip] = patchesOf(base(), (d: any) => {
			d.items.splice(1, 1)
		})
		expect(r).toEqual({items: [{x: 1}, {x: 3}, 30]})
		expect(p).toEqual([
			{op: "replace", path: ["items", 1], value: {x: 3}},
			{op: "replace", path: ["items", 2], value: 30},
			{op: "remove", path: ["items", 3]}
		])
		expect(ip).toEqual([
			{op: "replace", path: ["items", 1], value: {x: 2}},
			{op: "replace", path: ["items", 2], value: {x: 3}},
			{op: "add", path: ["items", 3], value: 30}
		])
		;[r, p, ip] = patchesOf(base(), (d: any) => {
			d.items.splice(1, 1, {x: 9}, {x: 8})
		})
		expect(r).toEqual({items: [{x: 1}, {x: 9}, {x: 8}, {x: 3}, 30]})
		expect(p).toEqual([
			{op: "replace", path: ["items", 1], value: {x: 9}},
			{op: "replace", path: ["items", 2], value: {x: 8}},
			{op: "replace", path: ["items", 3], value: {x: 3}},
			{op: "add", path: ["items", 4], value: 30}
		])
		expect(ip).toEqual([
			{op: "replace", path: ["items", 1], value: {x: 2}},
			{op: "replace", path: ["items", 2], value: {x: 3}},
			{op: "replace", path: ["items", 3], value: 30},
			{op: "remove", path: ["items", 4]}
		])
		;[r, p, ip] = patchesOf({items: [1, 2, 3]}, (d: any) => {
			d.items.splice(1, 0, 9)
		})
		expect(r).toEqual({items: [1, 9, 2, 3]})
		expect(p).toEqual([
			{op: "replace", path: ["items", 1], value: 9},
			{op: "replace", path: ["items", 2], value: 2},
			{op: "add", path: ["items", 3], value: 3}
		])
	})

	test("reverse / sort operate on copy_ without per-index proxies", () => {
		const [r, p] = patchesOf(
			{items: [30, {x: 3}, {x: 2}, {x: 1}]},
			(d: any) => {
				const state = d.items[DRAFT_STATE]
				const beforeDrafts = state.scope_.drafts_.length
				d.items.reverse()
				// Only the root object draft + the array draft exist; the plugin
				// must not draft the 4 elements.
				expect(state.scope_.drafts_.length).toBe(beforeDrafts)
				expect(state.copy_).not.toBeNull()
			}
		)
		expect(r).toEqual({items: [{x: 1}, {x: 2}, {x: 3}, 30]})
		expect(p).toEqual([
			{op: "replace", path: ["items", 0], value: {x: 1}},
			{op: "replace", path: ["items", 1], value: {x: 2}},
			{op: "replace", path: ["items", 2], value: {x: 3}},
			{op: "replace", path: ["items", 3], value: 30}
		])

		const [r2] = patchesOf({items: [3, 1, 2]}, (d: any) => {
			d.items.sort()
		})
		expect(r2).toEqual({items: [1, 2, 3]})

		const [r3] = patchesOf({items: [{x: 3}, {x: 1}, {x: 2}]}, (d: any) => {
			d.items.sort((a: any, b: any) => a.x - b.x)
		})
		expect(r3).toEqual({items: [{x: 1}, {x: 2}, {x: 3}]})
	})

	test("sort comparator receives raw values, not drafts", () => {
		produce({items: [{x: 2}, {x: 1}]}, (d: any) => {
			d.items.sort((a: any, b: any) => {
				expect(isDraft(a)).toBe(false)
				expect(isDraft(b)).toBe(false)
				return a.x - b.x
			})
		})
	})

	test("no-op mutations preserve base identity and create no patches", () => {
		const base: any = {items: [1, 2, 1]}
		const r = produce(base, (d: any) => {
			d.items.reverse()
		})
		expect(r).toBe(base)

		const empty: any[] = []
		const r2 = produce({items: empty}, (d: any) => {
			expect(d.items.pop()).toBeUndefined()
			expect(d.items.shift()).toBeUndefined()
			d.items.sort()
			d.items.reverse()
			expect(d.items.splice(0, 1)).toEqual([])
			expect(d.items.push()).toBe(0)
			expect(d.items.unshift()).toBe(0)
		})
		expect(r2.items).toBe(empty)

		const [, p3] = produceWithPatches({items: [1, 1, 1]}, (d: any) => {
			d.items.reverse()
		})
		expect(p3).toEqual([])
		const [, p4] = produceWithPatches({items: [1, 2, 3]}, (d: any) => {
			d.items.sort((a: number, b: number) => a - b)
		})
		expect(p4).toEqual([])
	})

	test("pop/shift/splice return drafts for removed draftable elements", () => {
		produce({items: [{x: 1}, {x: 2}, 3, "s", null, true]}, (d: any) => {
			const popped = d.items.pop()
			expect(isDraft(popped)).toBe(false) // true is not draftable
			const objPopped = (() => {
				d.items.push({y: 1})
				return d.items.pop()
			})()
			// freshly assigned raw values come back raw
			expect(isDraft(objPopped)).toBe(false)
			expect(objPopped).toEqual({y: 1})
		})
		produce({items: [{x: 1}, {x: 2}, {x: 3}]}, (d: any) => {
			const shifted = d.items.shift()
			expect(isDraft(shifted)).toBe(true)
		})
		produce({items: [{x: 1}, {x: 2}, {x: 3}]}, (d: any) => {
			const removed = d.items.splice(1, 1)
			expect(removed).toHaveLength(1)
			expect(isDraft(removed[0])).toBe(true)
		})
		// primitives come back as primitives
		produce({items: [1, 2, 3]}, (d: any) => {
			expect(d.items.pop()).toBe(3)
			expect(d.items.shift()).toBe(1)
			expect(d.items.splice(0, 1)).toEqual([2])
		})
	})

	test("length is maintained and subsequent indexed reads are consistent", () => {
		const r = produce({items: [1, 2, 3, 4, 5]}, (d: any) => {
			d.items.push(6)
			d.items.unshift(0)
			d.items.pop()
			d.items.shift()
			d.items.splice(1, 2, 20)
		})
		expect(r).toEqual({items: [1, 20, 4, 5]})
	})

	test("cross-references: pushed draft keeps shared identity and finalizes in place", () => {
		const [r, p] = produceWithPatches(
			{a: {x: 1}, items: [{y: 0}]},
			(d: any) => {
				d.items.push(d.a)
			}
		)
		expect(r.items[1]).toBe(r.a)
		expect(p).toEqual([{op: "add", path: ["items", 1], value: {x: 1}}])

		const [r2, p2] = produceWithPatches(
			{a: {x: 1}, items: [] as any[]},
			(d: any) => {
				d.items.push(d.a)
				d.a.x = 9
			}
		)
		expect(r2.items[0]).toBe(r2.a)
		expect(r2.a).toEqual({x: 9})
		expect(p2).toEqual([
			{op: "replace", path: ["a", "x"], value: 9},
			{op: "add", path: ["items", 0], value: {x: 9}}
		])
	})

	test("cross-references through splice/unshift", () => {
		const r = produce({a: {x: 1}, items: [1, 2]}, (d: any) => {
			d.items.unshift(d.a)
			d.items.splice(2, 0, d.a)
		})
		expect(r.items[0]).toBe(r.a)
		expect(r.items[2]).toBe(r.a)
		expect(r.items).toEqual([{x: 1}, 1, {x: 1}, 2])
	})

	test("nested draft modified then reversed: child patches are preserved", () => {
		const [r, p] = produceWithPatches({items: [{x: 1}, {x: 2}]}, (d: any) => {
			d.items[1].x = 5
			d.items.reverse()
		})
		expect(r).toEqual({items: [{x: 5}, {x: 1}]})
		expect(p).toEqual([
			{op: "replace", path: ["items", 0], value: {x: 5}},
			{op: "replace", path: ["items", 1], value: {x: 1}}
		])
	})

	test("results are frozen with autoFreeze", () => {
		const r = produce({items: [{x: 1}, {x: 2}]}, (d: any) => {
			d.items.reverse()
			d.items.push({x: 3})
		})
		expect(Object.isFrozen(r.items)).toBe(true)
		expect(Object.isFrozen(r.items[0])).toBe(true)
	})
})

describe("enableArrayMethods - read-only methods", () => {
	test("filter: raw callback values, drafts only for hits, mutation works", () => {
		produce({items: [{x: 1}, {x: 2}, {x: 3}]}, (d: any) => {
			const seen: any[] = []
			const filtered = d.items.filter((v: any, i: number) => {
				seen.push(v)
				expect(isDraft(v)).toBe(false)
				expect(typeof i).toBe("number")
				return v.x > 1
			})
			// no per-index proxy was handed to the 3 raw callback values
			expect(seen).toEqual([{x: 1}, {x: 2}, {x: 3}])
			expect(filtered).toHaveLength(2)
			expect(filtered.every(isDraft)).toBe(true)
			filtered[0].x = 42
			// hits were drafted in place and the change is observable
			expect(d.items[1].x).toBe(42)
			expect(d.items[2].x).toBe(3)
		})
		const r = produce({items: [{x: 1}, {x: 2}, {x: 3}]}, (d: any) => {
			d.items.filter((v: any) => v.x > 1)[0].x = 42
		})
		expect(r).toEqual({items: [{x: 1}, {x: 42}, {x: 3}]})
	})

	test("find / findLast return drafts only on hit", () => {
		produce({items: [{x: 1}, {x: 2}, {x: 3}, {x: 2}]}, (d: any) => {
			const found = d.items.find((v: any) => v.x === 2)
			expect(isDraft(found)).toBe(true)
			found.x = 20
			expect(d.items.find((v: any) => v.x === 99)).toBeUndefined()

			const last = d.items.findLast((v: any) => v.x === 2)
			expect(isDraft(last)).toBe(true)
			expect(last).toBe(d.items[3])
			last.x = 200
			expect(d.items.findLastIndex((v: any) => v.x === 20)).toBe(1)
			expect(d.items.findIndex((v: any) => v.x === 200)).toBe(3)
			expect(d.items.findIndex((v: any) => v.x === 99)).toBe(-1)
			expect(d.items.findLastIndex((v: any) => v.x === 99)).toBe(-1)
		})
	})

	test("some / every with raw values; indexOf / includes", () => {
		produce({items: [{x: 1}, {x: 2}, {x: 3}]}, (d: any) => {
			expect(
				d.items.some((v: any) => {
					expect(isDraft(v)).toBe(false)
					return v.x === 2
				})
			).toBe(true)
			expect(d.items.some((v: any) => v.x === 9)).toBe(false)
			expect(d.items.every((v: any) => v.x > 0)).toBe(true)
			expect(d.items.every((v: any) => v.x > 1)).toBe(false)

			expect(d.items.indexOf(d.items[1])).toBe(1)
			expect(d.items.indexOf({x: 2})).toBe(-1)
			expect(d.items.includes(d.items[2])).toBe(true)
			expect(d.items.includes({})).toBe(false)
			;(d.items as any).push(NaN)
			expect(d.items.includes(NaN)).toBe(true)
			expect(d.items.indexOf(NaN)).toBe(-1)
			expect(d.items.includes(d.items[0], 1)).toBe(false)
		})
	})

	test("slice drafts all included present elements", () => {
		produce({items: [{x: 1}, {x: 2}, {x: 3}]}, (d: any) => {
			const s = d.items.slice(1, 3)
			expect(s).toHaveLength(2)
			expect(s.every(isDraft)).toBe(true)
			s[0].x = 42
		})
		const r = produce({items: [{x: 1}, {x: 2}, {x: 3}]}, (d: any) => {
			d.items.slice(1)[0].x = 42
		})
		expect(r).toEqual({items: [{x: 1}, {x: 42}, {x: 3}]})
	})

	test("concat drafts receiver elements, passes args through", () => {
		produce({items: [{x: 1}, {x: 2}]}, (d: any) => {
			const external = {z: 0}
			const c = d.items.concat([{x: 3}], external, 4)
			expect(isDraft(c[0])).toBe(true)
			expect(isDraft(c[1])).toBe(true)
			expect(c[2]).toEqual({x: 3})
			expect(isDraft(c[2])).toBe(false)
			expect(c[3]).toBe(external)
			expect(c[4]).toBe(4)
		})
	})

	test("flat drafts reached nested draft arrays", () => {
		produce({items: [[{x: 1}], [{x: 2}, {x: 3}]]}, (d: any) => {
			const flat = d.items.flat()
			expect(flat).toHaveLength(3)
			expect(flat.every(isDraft)).toBe(true)
			flat[2].x = 30
		})
		const r = produce({items: [[{x: 1}], [{x: 2}, {x: 3}]]}, (d: any) => {
			d.items.flat()[0].x = 10
		})
		expect(r).toEqual({items: [[{x: 10}], [{x: 2}, {x: 3}]]})
	})

	test("join does not draft", () => {
		produce({items: [1, 2, 3]}, (d: any) => {
			const state = d.items[DRAFT_STATE]
			expect(d.items.join("-")).toBe("1-2-3")
			expect(state.copy_).toBeNull()
		})
	})

	test("inherited prototype members (constructor, toString) are not intercepted", () => {
		produce({items: [1, 2, 3]}, (d: any) => {
			expect(d.items.constructor).toBe(Array)
			const constructed = new d.items.constructor(1)
			expect(Array.isArray(constructed)).toBe(true)
			expect(constructed.length).toBe(1)
			expect(d.items.toString()).toBe("1,2,3")
			expect(typeof d.items[Symbol.iterator]).toBe("function")
			// iterating still yields drafts for objects, like baseline
			produce({items: [{x: 1}]}, (d2: any) => {
				const [first] = d2.items
				expect(isDraft(first)).toBe(true)
			})
		})
	})

	test("sparse arrays: holes skipped by callbacks, preserved by slice/concat", () => {
		const sparse: any[] = [1]
		sparse[3] = 4
		produce({items: sparse}, (d: any) => {
			const seen: number[] = []
			d.items.forEach?.((v: any, i: number) => seen.push(i)) // forEach not intercepted; still works
			const filtered = d.items.filter((v: any) => true)
			expect(filtered).toEqual([1, 4])
			expect(d.items.findIndex((v: any) => v === 4)).toBe(3)
			const sliced = d.items.slice(0, 4)
			expect(1 in sliced).toBe(false)
			expect(sliced[3]).toBe(4)
			expect(d.items.some((v: any) => v === 4)).toBe(true)
			expect(d.items.every((v: any) => v > 0)).toBe(true)
			const c = d.items.concat([])
			expect(1 in c).toBe(false)
			const f = d.items.flat()
			expect(f).toEqual([1, 4])
		})
	})

	test("map/flatMap/reduce/forEach are deliberately NOT intercepted", () => {
		produce({items: [{x: 1}, {x: 2}]}, (d: any) => {
			d.items.forEach((v: any) => {
				expect(isDraft(v)).toBe(true)
			})
			d.items.map((v: any) => {
				expect(isDraft(v)).toBe(true)
				return v
			})
			d.items.reduce((acc: any, v: any) => {
				expect(isDraft(v)).toBe(true)
				return acc
			}, 0)
			d.items.flatMap((v: any) => {
				expect(isDraft(v)).toBe(true)
				return [v]
			})
		})
	})

	test("read-only methods never mark the draft modified", () => {
		produce({items: [1, 2, 3]}, (d: any) => {
			d.items.filter(() => true)
			d.items.slice()
			d.items.concat([4])
			d.items.flat()
			d.items.find(() => true)
			d.items.findLast(() => true)
			d.items.findIndex(() => true)
			d.items.findLastIndex(() => true)
			d.items.some(() => false)
			d.items.every(() => true)
			d.items.indexOf(1)
			d.items.includes(1)
			d.items.join()
			expect(d.items[DRAFT_STATE].modified_).toBe(false)
			expect(d.items[DRAFT_STATE].copy_).toBeNull()
		})
	})
})

describe("enableArrayMethods - error propagation", () => {
	test("callback errors propagate from the exact method call", () => {
		expect(() =>
			produce({items: [1]}, (d: any) => {
				d.items.filter(() => {
					throw new Error("boom-filter")
				})
			})
		).toThrow("boom-filter")
		expect(() =>
			produce({items: [1, 2]}, (d: any) => {
				d.items.sort(() => {
					throw new Error("boom-sort")
				})
			})
		).toThrow("boom-sort")
		expect(() =>
			produce({items: [1]}, (d: any) => {
				d.items.find(() => {
					throw new Error("boom-find")
				})
			})
		).toThrow("boom-find")
	})

	test("non-function callbacks and comparators throw the native TypeError", () => {
		const callbackMethods = [
			"filter",
			"find",
			"findLast",
			"findIndex",
			"findLastIndex",
			"some",
			"every"
		] as const
		for (const method of callbackMethods) {
			for (const bad of [undefined, null, 42]) {
				expect(() =>
					produce({items: [1]}, (d: any) => {
						;(d.items as any)[method](bad)
					})
				).toThrow(TypeError)
			}
		}
		// Native validates the comparator even on an empty array
		expect(() =>
			produce({items: []}, (d: any) => {
				d.items.sort(42)
			})
		).toThrow(TypeError)
		// undefined selects the default ordering
		expect(
			produce({items: [3, 1, 2]}, (d: any) => {
				d.items.sort(undefined)
			})
		).toEqual({items: [1, 2, 3]})
	})
})

describe("enableArrayMethods - finalize / scope consistency", () => {
	test("read-only draft that is never mutated is pruned back to base", () => {
		const base = {items: [{x: 1}, {x: 2}]}
		const r = produce(base, (d: any) => {
			const found = d.items.find((v: any) => v.x === 2)
			expect(isDraft(found)).toBe(true)
		})
		expect(r).toBe(base)
		expect(r.items[1]).toBe(base.items[1])
	})

	test("read-only hit moved by a later bulk mutation finalizes at new slot", () => {
		const r = produce({items: [{x: 1}, {x: 2}, {x: 3}]}, (d: any) => {
			const hit = d.items.filter((v: any) => v.x === 2)[0]
			d.items.reverse()
			hit.x = 200
		})
		expect(r).toEqual({items: [{x: 3}, {x: 200}, {x: 1}]})
	})

	test("same draft inserted multiple times keeps one shared final identity", () => {
		const r = produce({a: {z: 1}, items: [] as any[]}, (d: any) => {
			d.items.push(d.a, d.a)
			d.a.z = 7
		})
		expect(r.items[0]).toBe(r.a)
		expect(r.items[1]).toBe(r.a)
		expect(r.items).toEqual([{z: 7}, {z: 7}])

		const r2 = produce({a: {z: 1}, items: [1, 2, 3, 4]}, (d: any) => {
			d.items.unshift(d.a)
			d.items.splice(3, 0, d.a)
			d.a.z = 5
		})
		expect(r2.items[0]).toBe(r2.a)
		expect(r2.items[3]).toBe(r2.a)
		expect(r2.items).toEqual([{z: 5}, 1, 2, {z: 5}, 3, 4])
	})

	test("idempotent bulk operations produce no patches", () => {
		const base = {items: [1, 2, 3, 4]}
		const [r, p] = produceWithPatches(base, (d: any) => {
			d.items.reverse()
			d.items.reverse()
		})
		expect(r).toEqual(base)
		expect(p).toEqual([])

		const base2 = {items: [1, 2, 3]}
		const [r2, p2] = produceWithPatches(base2, (d: any) => {
			d.items.shift()
			d.items.unshift(1)
		})
		expect(r2).toEqual(base2)
		expect(p2).toEqual([])
	})

	test("mixed indexed writes and bulk methods produce coherent patches", () => {
		const base = {items: [1, 2, 3, 4]}
		const [r, p, ip] = produceWithPatches(base, (d: any) => {
			d.items[0] = 10
			d.items.reverse()
		})
		expect(r).toEqual({items: [4, 3, 2, 10]})
		expect(applyPatches(base, p)).toEqual(r)
		expect(applyPatches(r, ip)).toEqual(base)
	})

	test("createDraft / finishDraft works with bulk mutations", () => {
		const base = {items: [{x: 1}, {x: 2}]}
		const d = createDraft(base)
		d.items.reverse()
		d.items.push({x: 3})
		let collected: [any[], any[]] | undefined
		const r = finishDraft(d, (p: any, ip: any) => {
			collected = [p, ip]
		})
		expect(r).toEqual({items: [{x: 2}, {x: 1}, {x: 3}]})
		expect(applyPatches(base, collected![0])).toEqual(r)
		expect(applyPatches(r, collected![1])).toEqual(base)
	})

	test("nested array patch paths are correct", () => {
		const [, p] = produceWithPatches({a: {b: {items: [1, 2, 3]}}}, (d: any) => {
			d.a.b.items.push(4)
		})
		expect(p).toEqual([{op: "add", path: ["a", "b", "items", 3], value: 4}])
	})

	test("map / forEach / reduce / flatMap still hand over drafts", () => {
		const r = produce({items: [{x: 1}, {x: 2}]}, (d: any) => {
			d.items.forEach((v: any) => {
				expect(isDraft(v)).toBe(true)
				v.x++
			})
			expect(d.items.map((v: any) => v.x)).toEqual([2, 3])
			expect(d.items.reduce((a: number, v: any) => a + v.x, 0)).toBe(5)
			expect(d.items.flatMap((v: any) => [v.x, -v.x])).toEqual([2, -2, 3, -3])
		})
		expect(r).toEqual({items: [{x: 2}, {x: 3}]})
	})

	test("thisArg is honored by callbacks", () => {
		const ctx = {threshold: 2}
		produce({items: [1, 2, 3]}, (d: any) => {
			expect(
				d.items.some(function(this: any, v: number) {
					return v > this.threshold
				}, ctx)
			).toBe(true)
			expect(
				d.items.findIndex(function(this: any, v: number) {
					return v === this.threshold
				}, ctx)
			).toBe(1)
		})
	})

	test("sparse arrays: holes preserved by native bulk mutations", () => {
		// Deep-freeze traverses holes, so disable autoFreeze to inspect the
		// raw hole structure of the finalized copy.
		setAutoFreeze(false)
		try {
			const allHoles: any[] = []
			allHoles.length = 3
			const allHolesResult = produce({items: allHoles}, (d: any) => {
				d.items.reverse()
			})
			expect(0 in allHolesResult.items).toBe(false)

			const partial: any[] = [1, 2]
			partial[4] = 5
			const r = produce({items: partial}, (d: any) => {
				d.items.reverse()
			})
			expect(r.items[0]).toBe(5)
			expect(1 in r.items).toBe(false)
			expect(r.items[4]).toBe(1)

			produce({items: [1, 2, , , 5] as any}, (d: any) => {
				const seen: any[] = []
				d.items.some((v: any) => {
					seen.push(v)
					return false
				})
				expect(seen).toEqual([1, 2, 5])
			})
			produce({items: [1, 2, , , 5] as any}, (d: any) => {
				const sliced = d.items.slice(0, 5)
				expect(sliced).toHaveLength(5)
				expect(1 in sliced).toBe(true)
				expect(2 in sliced).toBe(false)
				expect(3 in sliced).toBe(false)
				expect(sliced[0]).toBe(1)
				expect(sliced[4]).toBe(5)
			})
		} finally {
			setAutoFreeze(true)
		}
	})
})
