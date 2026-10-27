import { randomBytes, scrypt, timingSafeEqual, createHash, type ScryptOptions } from 'node:crypto'

const derive = (password: string, salt: string, length: number, options: ScryptOptions) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key))
})
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
// Bound expensive work across all clients, not only each IP's rate limit.
let active = 0
const waiting: (() => void)[] = []
async function deriveKey(password: string, salt: string, legacy = false): Promise<Buffer> {
  if (active >= 4) {
    if (waiting.length >= 32) fail(429, 'درخواست‌های زیادی ارسال شده است؛ کمی صبر کنید')
    await new Promise<void>(resolve => waiting.push(resolve))
  } else active++
  try {
    return await derive(password, salt, 64, legacy ? {} : scryptOptions) as Buffer
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await deriveKey(password, salt)
  return `scrypt-v1:${salt}:${key.toString('hex')}`
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(':')
  const [algorithm, salt, hex] = parts
  if (parts.length !== 3 || !['scrypt', 'scrypt-v1'].includes(algorithm) || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hex)) return false
  const key = await deriveKey(password, salt, algorithm === 'scrypt')
  return timingSafeEqual(key, Buffer.from(hex, 'hex'))
}
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}
export const fail = (status: number, message: string): never => { throw new HttpError(status, message) }
