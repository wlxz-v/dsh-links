import assert from "node:assert/strict"
import test from "node:test"
import { getBounded, setBounded } from "../src/bounded-map.js"

test("bounded-map：命中刷新最近使用顺序，超出上限淘汰最旧项", () => {
  const map = new Map()
  setBounded(map, "a", 1, 3)
  setBounded(map, "b", 2, 3)
  setBounded(map, "c", 3, 3)
  assert.equal(getBounded(map, "a"), 1)
  setBounded(map, "d", 4, 3)
  assert.deepEqual([...map.keys()], ["c", "a", "d"])
  assert.equal(getBounded(map, "b"), undefined)
})
