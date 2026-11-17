/**
 * 基于 JS Map 插入顺序的轻量有界 LRU：
 * - getBounded 命中时把条目移到末尾；
 * - setBounded 写入后淘汰超出上限的最早条目。
 */
export function getBounded(map, key) {
  if (!map || !map.has(key)) return undefined
  const value = map.get(key)
  map.delete(key)
  map.set(key, value)
  return value
}

export function setBounded(map, key, value, maxEntries) {
  if (!map) return
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
