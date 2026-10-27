import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type PrismaClient, Prisma } from '@prisma/client'
import { buildApp } from '../src/app.js'
import { hashToken, newToken } from '../src/security.js'

test('HTTP contract: authorization, role boundaries, validation and Persian errors', async t => {
  const token = newToken()
  let user = { id: 'u1', name: 'کاربر', email: 'user@example.com', role: 'CUSTOMER', status: 'ACTIVE', passwordHash: 'never-expose', shopName: null, phone: null, address: null }
  let expiresAt = new Date(Date.now() + 60000)
  let deleted = false
  const db = {
    session: {
      findUnique: async ({ where }: any) => !deleted && where.tokenHash === hashToken(token) ? { user, expiresAt } : null,
      deleteMany: async () => { deleted = true; return { count: 1 } },
    },
    user: { findUniqueOrThrow: async () => { const { passwordHash, ...safe } = user; return safe } },
    product: { findMany: async () => [], count: async () => 0 },
    $transaction: async (queries: any[]) => Promise.all(queries),
  } as unknown as PrismaClient
  const app = await buildApp({ db })
  t.after(() => app.close())
  const headers = { authorization: `Bearer ${token}` }
  const privatePaths = ['/api/auth/me', '/api/orders', '/api/vendor/dashboard', '/api/vendor/products', '/api/vendor/orders', '/api/admin/users', '/api/admin/dashboard', '/api/admin/orders', '/api/admin/products', '/api/admin/categories']
  for (const url of privatePaths) {
    const response = await app.inject({ url })
    assert.equal(response.statusCode, 401, url)
    assert.deepEqual(Object.keys(response.json()), ['message'])
    assert.match(response.json().message, /[\u0600-\u06ff]/)
  }
  for (const authorization of ['Bearer forged', `Basic ${token}`, `Bearer ${newToken()}`]) {
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { authorization } })).statusCode, 401)
  }
  const me = await app.inject({ url: '/api/auth/me', headers })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().id, 'u1')
  assert.equal('passwordHash' in me.json(), false)
  for (const url of ['/api/vendor/dashboard', '/api/admin/dashboard']) assert.equal((await app.inject({ url, headers })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: { role: 'ADMIN' } })).statusCode, 400)
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/account', headers, payload: { role: 'ADMIN' } })).statusCode, 400)
  assert.equal((await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { items: [] } })).statusCode, 400)
  user = { ...user, role: 'VENDOR', status: 'PENDING' }
  assert.equal((await app.inject({ url: '/api/vendor/products', headers })).statusCode, 403)
  user = { ...user, status: 'SUSPENDED' }
  assert.equal((await app.inject({ url: '/api/auth/me', headers })).statusCode, 403)
  user = { ...user, status: 'ACTIVE' }
  expiresAt = new Date(0)
  assert.equal((await app.inject({ url: '/api/auth/me', headers })).statusCode, 401)
  expiresAt = new Date(Date.now() + 60000)
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/auth/me', headers })).statusCode, 401)
  const products = await app.inject({ url: '/api/products' })
  assert.deepEqual(products.json(), { products: [], total: 0, page: 1, pages: 0 })
  assert.equal((await app.inject({ url: '/api/products?limit=1000' })).statusCode, 400)
  assert.equal((await app.inject({ url: '/not-found' })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{' })).statusCode, 400)
})

test('database errors do not leak SQL, credentials or stack traces', async t => {
  let error: Error = new Prisma.PrismaClientKnownRequestError('sensitive SQL', { code: 'P2002', clientVersion: '6' })
  const db = { product: { findFirst: async () => { throw error } } } as unknown as PrismaClient
  const app = await buildApp({ db })
  t.after(() => app.close())
  assert.equal((await app.inject({ url: '/api/products/example' })).statusCode, 409)
  error = new Error('postgresql://secret:password@host/db')
  const response = await app.inject({ url: '/api/products/example' })
  assert.equal(response.statusCode, 503)
  assert.deepEqual(Object.keys(response.json()), ['message'])
  assert.doesNotMatch(response.body, /password|postgresql|stack/)
})
