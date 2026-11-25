/**
 * 安全的原子文件持久化：
 * - 随机临时文件名 + O_EXCL（防符号链接与并发碰撞，且新文件始终以 0o600 创建）；
 * - 写入后 fsync 落盘再 rename，避免断电产生 0 字节损坏文件；
 * - Windows 上对杀毒/索引瞬时锁引起的 EPERM/EACCES/EBUSY 做短重试，失败必清理临时文件。
 */
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"])
const WAIT_BUF = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms) {
  try {
    Atomics.wait(WAIT_BUF, 0, 0, ms)
  } catch {
    // 某些受限环境不支持 Atomics.wait 时直接跳过等待
  }
}

export function assertNotSymlinkSync(targetPath, label = "file") {
  try {
    const st = lstatSync(targetPath)
    if (st.isSymbolicLink()) {
      throw new Error(`dsh-links: refusing to access symlink ${label} (${targetPath})`)
    }
  } catch (err) {
    if (err?.code === "ENOENT") return
    throw err
  }
}

export function writeFileAtomicSync(file, data, { mode = 0o600, dirMode = 0o700 } = {}) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: dirMode })
  try { chmodSync(dir, dirMode) } catch {}
  assertNotSymlinkSync(dir, "state directory")
  assertNotSymlinkSync(file, "state file")

  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  const openFlags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (fsConstants.O_NOFOLLOW ?? 0)

  let fd = null
  try {
    fd = openSync(tmp, openFlags, mode)
    writeFileSync(fd, data)
    try { fsyncSync(fd) } catch {}
    closeSync(fd)
    fd = null

    let lastErr = null
    const maxAttempts = process.platform === "win32" ? 4 : 1
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        renameSync(tmp, file)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        if (!RETRYABLE_RENAME_CODES.has(err?.code) || attempt + 1 >= maxAttempts) break
        sleepSync(15 * (attempt + 1))
      }
    }
    if (lastErr) throw lastErr
    try { chmodSync(file, mode) } catch {}
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}
