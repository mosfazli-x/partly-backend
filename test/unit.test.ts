import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { hashPassword, verifyPassword, newToken, hashToken, HttpError } from '../src/security.js'
import { aggregateStatus, canTransition, jsonValue, vendorOrder, atomic } from '../src/marketplace.js'
import * as v from '../src/validation.js'

const shipping = { name: 'خریدار', phone: '09123456789', address: 'تهران، خیابان نمونه', postalCode: '1234567890' }

test('scrypt is salted, verifies passwords, rejects malformed hashes and supports legacy hashes', async () => {
  const first = await hashPassword('a-strong-password'), second = await hashPassword('a-strong-password')
  assert.notEqual(first, second)
  assert.match(first, /^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{128}$/)
  assert.equal(await verifyPassword('a-strong-password', first), true)
  assert.equal(await verifyPassword('wrong-password', first), false)
  for (const value of ['', 'sha256:salt:hash', first + ':extra', 'scrypt-v1:x:' + 'a'.repeat(128)]) {
    assert.equal(await verifyPassword('a-strong-password', value), false)
  }
  const salt = 'a'.repeat(32)
  const legacy = `scrypt:${salt}:${scryptSync('old-password', salt, 64).toString('hex')}`
  assert.equal(await verifyPassword('old-password', legacy), true)
})

test('opaque sessions have 256 bits of randomness and only a SHA256 digest is persisted', () => {
  const token = newToken()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(token, newToken())
  assert.match(hashToken(token), /^[a-f0-9]{64}$/)
  assert.notEqual(hashToken(token), token)
})

test('registration is customer-only and normalizes email', () => {
  const base = { name: 'کاربر', email: ' TEST@example.com ', password: 'a-strong-password' }
  assert.equal(v.registration.parse(base).email, 'test@example.com')
  for (const changes of [{ role: 'ADMIN' }, { role: 'VENDOR' }, { role: 'CUSTOMER' }, { status: 'ACTIVE' }, { password: 'short' }, { shopName: 'فروشگاه' }]) {
    assert.equal(v.registration.safeParse({ ...base, ...changes }).success, false)
  }
  assert.equal(v.registration.safeParse(base).success, true)
})

test('checkout rejects duplicates, fractional/negative quantities and client-controlled prices/status', () => {
  const item = { productId: 'p1', quantity: 1 }
  assert.equal(v.checkout.safeParse({ ...shipping, items: [item] }).success, true)
  for (const items of [[], [item, item], [{ ...item, quantity: 0 }], [{ ...item, quantity: 1.5 }], [{ ...item, price: 1 }]]) {
    assert.equal(v.checkout.safeParse({ ...shipping, items }).success, false)
  }
  assert.equal(v.checkout.safeParse({ ...shipping, items: [item], status: 'DELIVERED' }).success, false)
  assert.equal(v.checkout.safeParse({ ...shipping, items: [item], postalCode: '123' }).success, false)
})

test('listing and profile validation blocks mass assignment and unsafe image URLs', () => {
  const listing = { name: 'لنت', sku: 'SKU-1', description: '', price: 850000, stock: 1, brand: 'پارس', categoryId: 'cat', image: '/products/brake-pad.svg' }
  assert.equal(v.listing.safeParse(listing).success, true)
  for (const changes of [{ price: -1 }, { price: 1.5 }, { stock: -1 }, { vendorId: 'other' }, { status: 'ACTIVE' }, { image: 'javascript:alert(1)' }, { image: '//evil.test/x' }]) {
    assert.equal(v.listing.safeParse({ ...listing, ...changes }).success, false)
  }
  assert.equal(v.listingPatch.safeParse({}).success, false)
  assert.equal(v.profile.safeParse({ role: 'ADMIN' }).success, false)
})

test('pagination is bounded and prices are not scaled from toman', () => {
  assert.deepEqual(v.query.parse({}), { sort: 'newest', page: 1, limit: 20 })
  for (const query of [{ page: 0 }, { limit: 101 }, { sort: 'unknown' }, { min: 10, max: 1 }]) {
    assert.equal(v.query.safeParse(query).success, false)
  }
  assert.deepEqual(jsonValue({ price: new Prisma.Decimal(850000), items: [new Prisma.Decimal('12.5')], at: new Date('2026-01-01') }), { price: 850000, items: [12.5], at: '2026-01-01T00:00:00.000Z' })
})

test('fulfillment transitions are forward-only, cancellation terminal, mixed vendors aggregated', () => {
  assert.equal(canTransition('PENDING', 'PROCESSING'), true)
  assert.equal(canTransition('PENDING', 'SHIPPED'), false)
  assert.equal(canTransition('SHIPPED', 'CANCELLED'), false)
  assert.equal(canTransition('CANCELLED', 'PENDING'), false)
  assert.equal(canTransition('CANCELLED', 'CANCELLED'), true)
  assert.equal(aggregateStatus(['CANCELLED', 'CANCELLED']), 'CANCELLED')
  assert.equal(aggregateStatus(['PENDING', 'CANCELLED']), 'PENDING')
  assert.equal(aggregateStatus(['PROCESSING', 'PENDING']), 'PROCESSING')
  assert.equal(aggregateStatus(['SHIPPED', 'DELIVERED']), 'SHIPPED')
  assert.equal(aggregateStatus(['DELIVERED', 'CANCELLED']), 'DELIVERED')
})

test('vendor projection removes other vendors items, totals and buyer account', () => {
  const order = { id: 'o1', total: new Prisma.Decimal(999999), user: { email: 'private@example.com' }, items: [
    { vendorId: 'v1', price: new Prisma.Decimal(850000), quantity: 2, status: 'PENDING' as const },
    { vendorId: 'v2', price: new Prisma.Decimal(1), quantity: 1, status: 'DELIVERED' as const },
  ] }
  const result = vendorOrder(order, 'v1')
  assert.equal(result.items.length, 1)
  assert.equal(result.total.toNumber(), 1700000)
  assert.equal(result.status, 'PENDING')
  assert.equal('user' in result, false)
})

test('serializable transactions retry only write conflicts, not domain failures', async () => {
  let attempts = 0
  const db = { $transaction: async (fn: () => Promise<number>, options: { isolationLevel: string }) => {
    assert.equal(options.isolationLevel, 'Serializable')
    if (++attempts < 3) throw new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6' })
    return fn()
  } } as unknown as PrismaClient
  assert.equal(await atomic(db, async () => 42), 42)
  assert.equal(attempts, 3)
  await assert.rejects(atomic(db, async () => { throw new HttpError(409, 'موجودی کافی نیست') }), { statusCode: 409 })
  assert.equal(attempts, 4)
})
