/**
 * 局域网地址可达性（E1）：
 *   - 198.18.0.0/15（Clash TUN 等虚拟网卡）与 169.254.0.0/16（WiFi 没连上时的自分配地址）
 *     手机永远连不上，不能进二维码，更不能抢「推荐」位；
 *   - 其余地址按私网优先级排序：192.168 > 10 / 172.16-31 > tailnet / 公网，
 *     同一优先级保持系统枚举顺序（面板刷新不跳位）。
 * App 侧(PairClient.firstReachable)是所有地址并发探测，顺序只影响面板与兜底基址。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { isUnreachableIPv4, lanInfosForAddresses, lanPreference } from "../src/index.js"

test("不可达网段：198.18/15 与 169.254/16", () => {
  assert.equal(isUnreachableIPv4("198.18.0.1"), true)
  assert.equal(isUnreachableIPv4("198.19.255.254"), true)
  assert.equal(isUnreachableIPv4("169.254.10.7"), true)
  assert.equal(isUnreachableIPv4("192.168.1.10"), false)
  assert.equal(isUnreachableIPv4("10.0.0.5"), false)
  assert.equal(isUnreachableIPv4("198.20.0.1"), false)
  assert.equal(isUnreachableIPv4("100.64.0.10"), false)
  assert.equal(isUnreachableIPv4(""), false)
  assert.equal(isUnreachableIPv4("not-an-ip"), false)
})

test("私网优先级", () => {
  assert.equal(lanPreference("192.168.1.10"), 3)
  assert.equal(lanPreference("10.1.2.3"), 2)
  assert.equal(lanPreference("172.16.0.1"), 2)
  assert.equal(lanPreference("172.31.255.254"), 2)
  assert.equal(lanPreference("172.32.0.1"), 1)
  assert.equal(lanPreference("100.64.0.10"), 1)
  assert.equal(lanPreference("203.0.113.9"), 1)
})

test("排序按优先级，同分保持系统顺序", () => {
  const lan = lanInfosForAddresses(
    ["169.254.10.7", "172.20.0.5", "10.1.1.1", "198.18.0.1", "192.168.0.9", "100.64.0.10", "172.20.0.6"],
    18640,
  )
  assert.deepEqual(lan.urls, [
    "https://192.168.0.9:18640",
    "https://172.20.0.5:18640",
    "https://10.1.1.1:18640",
    "https://172.20.0.6:18640",
    "https://100.64.0.10:18640",
  ])
  assert.equal(lan.infos[0].isRecommended, true)
  assert.deepEqual(lan.infos.filter((info) => info.isRecommended).map((info) => info.label), ["192.168.0.9"])
})

test("推荐位给最优先的私网地址，而不是列表里第一个", () => {
  const lan = lanInfosForAddresses(["203.0.113.9", "10.9.9.9", "192.168.1.5"], 18640)
  assert.deepEqual(lan.urls, ["https://192.168.1.5:18640", "https://10.9.9.9:18640", "https://203.0.113.9:18640"])
  assert.equal(lan.infos[0].category, "private")
  assert.equal(lan.infos[0].isRecommended, true)
  assert.equal(lan.infos[1].isRecommended, false)
  assert.equal(lan.infos[2].isRecommended, false)
})

test("只有不可达地址时列表为空（面板据此提示未发现可用局域网地址）", () => {
  const lan = lanInfosForAddresses(["169.254.1.1", "198.19.0.2"], 18640)
  assert.deepEqual(lan.urls, [])
  assert.deepEqual(lan.infos, [])
})

test("重复地址只保留一次", () => {
  const lan = lanInfosForAddresses(["192.168.1.10", "192.168.1.10"], 18640)
  assert.deepEqual(lan.urls, ["https://192.168.1.10:18640"])
})
