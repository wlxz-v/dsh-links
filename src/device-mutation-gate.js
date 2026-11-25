/** Returned when a mutation was registered but the device was revoked first. */
export const DEVICE_MUTATION_REVOKED = Symbol("deviceMutationRevoked")

/**
 * Tracks device-authorized mutations that may outlive their HTTP request.
 * Revocation drains this gate before it acknowledges success, so callers never
 * observe a successful revocation followed by a late mutation from that device.
 */
export class DeviceMutationGate {
  constructor() {
    this.inflight = new Map()
  }

  run(deviceId, operation) {
    const key = String(deviceId ?? "")
    let operations = this.inflight.get(key)
    if (!operations) {
      operations = new Set()
      this.inflight.set(key, operations)
    }

    // Register before invoking operation. This closes the authorization-to-start
    // gap because JavaScript cannot interleave a revocation in this synchronous
    // section.
    const pending = Promise.resolve().then(operation)
    operations.add(pending)
    const done = () => {
      operations.delete(pending)
      if (operations.size === 0) this.inflight.delete(key)
    }
    pending.then(done, done)
    return pending
  }

  async drain(deviceId, { timeoutMs = 0 } = {}) {
    const key = String(deviceId ?? "")
    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    const deadline = hasTimeout ? Date.now() + timeoutMs : Infinity
    for (;;) {
      const operations = this.inflight.get(key)
      if (!operations || operations.size === 0) return { drained: true, pending: 0 }
      const settled = Promise.allSettled([...operations])
      if (!hasTimeout) {
        await settled
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return { drained: false, pending: this.inflight.get(key)?.size ?? 0 }
      }
      let timer
      const timedOut = await Promise.race([
        settled.then(() => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(true), remaining)
          timer.unref?.()
        }),
      ])
      clearTimeout(timer)
      if (timedOut) {
        return { drained: false, pending: this.inflight.get(key)?.size ?? 0 }
      }
    }
  }
}

/**
 * Register before checking authorization. This closes the gap between the
 * outer HTTP auth check and revocation: a mutation admitted before revocation
 * is drained, while one admitted after revocation is rejected inside the gate.
 */
export function runAuthorizedDeviceMutation(gate, deviceId, isAuthorized, operation) {
  return gate.run(deviceId, async () => {
    if (!isAuthorized()) return DEVICE_MUTATION_REVOKED
    return operation()
  })
}
