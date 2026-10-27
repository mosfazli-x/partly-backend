import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'
import { hashPassword, hashToken } from '../src/security.js'

// Never use DATABASE_URL: tests own only a freshly-created random schema.
const testUrl = process.env.TEST_DATABASE_URL
const cwd = fileURLToPath(new URL('..', import.meta.url))
test('PostgreSQL integration: migrations, seed, auth, moderation, isolation and atomic orders', { skip: !testUrl, timeout: 120000 }, async t => {
  const schema = `pluck_test_${randomUUID().replaceAll('-', '')}`
  const url = new URL(testUrl!)
  url.searchParams.set('schema', schema)
  const db = new PrismaClient({ datasourceUrl: url.toString() })
  t.after(async () => {
    try { await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await db.$disconnect() }
  })
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  const cli = (script: string, args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url.toString(), SEED_DEMO_PASSWORD: '' } })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  cli('node_modules/prisma/build/index.js', ['migrate', 'deploy'])
  cli('node_modules/prisma/build/index.js', ['migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'])
  const app = await buildApp({ db })
  t.after(() => app.close())
  const password = `Test-${randomUUID()}`
  const safeKeys = ['address', 'email', 'id', 'name', 'phone', 'role', 'shopName', 'status']
  const request = async (method: 'GET' | 'POST' | 'PATCH', path: string, token?: string, payload?: Record<string, unknown>, status = 200) => {
    const response = await app.inject({ method, url: `/api${path}`, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(payload !== undefined ? { payload } : {}) })
    assert.equal(response.statusCode, status, `${method} ${path}: ${response.body}`)
    return response.json()
  }
  const register = (email: string) => request('POST', '/auth/register', undefined, { name: 'کاربر نمونه', email, password }, 201)
  const createVendor = async (email: string, shopName: string) => {
    await db.user.create({ data: { name: 'فروشنده نمونه', email, passwordHash: await hashPassword(password), role: 'VENDOR', status: 'PENDING', shopName } })
    return request('POST', '/auth/login', undefined, { email, password })
  }
  const customer = await register('buyer@example.com')
  const stranger = await register('stranger@example.com')
  const vendor = await createVendor('vendor@example.com', 'فروشگاه نمونه')
  const otherVendor = await createVendor('vendor2@example.com', 'فروشگاه دوم')
  await db.user.create({ data: { name: 'مدیر', email: 'admin@example.com', passwordHash: await hashPassword(password), role: 'ADMIN' } })
  const admin = await request('POST', '/auth/login', undefined, { email: 'admin@example.com', password })

  await t.test('registration/login store only hashes and pending vendors cannot manage listings', async () => {
    assert.deepEqual(Object.keys(customer.user).sort(), safeKeys)
    assert.equal(customer.user.role, 'CUSTOMER')
    assert.equal(vendor.user.status, 'PENDING')
    const stored = await db.user.findUniqueOrThrow({ where: { id: customer.user.id } })
    assert.notEqual(stored.passwordHash, password)
    assert.equal((await db.session.findUniqueOrThrow({ where: { tokenHash: hashToken(customer.token) } })).userId, stored.id)
    await request('POST', '/auth/register', undefined, { name: 'duplicate', email: 'BUYER@example.com', password }, 409)
    await request('POST', '/auth/register', undefined, { name: 'privileged', email: 'privileged@example.com', password, role: 'VENDOR' }, 400)
    await request('POST', '/auth/login', undefined, { email: stored.email, password: 'wrong-password' }, 401)
    await request('GET', '/vendor/products', vendor.token, undefined, 403)
    await request('PATCH', '/admin/users/' + vendor.user.id, admin.token, { status: 'ACTIVE' })
    await request('PATCH', '/admin/users/' + otherVendor.user.id, admin.token, { status: 'ACTIVE' })
    await request('PATCH', '/account', customer.token, { phone: '09123456789', address: 'تهران' })
  })

  const category = await request('POST', '/admin/categories', admin.token, { name: 'ترمز', slug: 'brakes' }, 201)
  const child = await request('POST', '/admin/categories', admin.token, { name: 'لنت', slug: 'pads', parentId: category.id }, 201)
  const make = await db.vehicleMake.create({ data: { name: 'خودروساز', slug: 'test-make', type: 'CAR' } })
  const model = await db.vehicleModel.create({ data: { name: 'مدل', slug: 'test-model', makeId: make.id } })
  const variant = await db.vehicleVariant.create({ data: { name: 'تیپ', slug: 'test-variant', modelId: model.id } })
  const listing = { name: 'لنت ترمز', sku: 'TEST-1', description: 'توضیحات', price: 850000, stock: 3, brand: 'پارس', categoryId: category.id, image: '/products/brake-pad.svg', condition: 'NEW', variantIds: [variant.id] }
  const product = await request('POST', '/vendor/products', vendor.token, listing, 201)
  const second = await request('POST', '/vendor/products', otherVendor.token, { ...listing, sku: 'TEST-2', price: 100000, stock: 5 }, 201)

  await t.test('moderation, public filters, ownership, nested vehicles and catalog compatibility', async () => {
    assert.equal(product.status, 'PENDING')
    assert.equal((await request('GET', '/products')).total, 0)
    await request('GET', '/products/' + product.slug, undefined, undefined, 404)
    await request('PATCH', '/vendor/products/' + product.id, otherVendor.token, { stock: 100 }, 404)
    await request('PATCH', '/vendor/products/' + product.id, vendor.token, { status: 'ACTIVE' }, 400)
    await request('PATCH', '/admin/products/' + product.id, admin.token, { status: 'ACTIVE' })
    await request('PATCH', '/admin/products/' + second.id, admin.token, { status: 'ACTIVE' })
    const publicProducts = await request('GET', '/products?category=brakes&sort=price-asc&page=1&limit=1')
    assert.equal(publicProducts.total, 2)
    assert.equal(publicProducts.pages, 2)
    assert.equal(publicProducts.products[0].price, 100000)
    assert.equal((await request('GET', '/products?q=TEST-1')).total, 1)
    const detail = await request('GET', '/products/' + product.slug)
    assert.equal(detail.fitments[0].variant.model.make.id, make.id)
    assert.equal(detail.vendor.id, vendor.user.id)
    assert.equal('email' in detail.vendor, false)
    assert.equal((await request('GET', '/vehicles'))[0].models[0].variants[0].id, variant.id)
    assert.equal((await request('GET', '/catalog/' + variant.id)).products.length, 2)
    assert.equal((await request('GET', '/search?q=TEST-1')).products.length, 1)
    await request('PATCH', '/admin/categories/' + category.id, admin.token, { parentId: child.id }, 400)
    await request('PATCH', '/admin/categories/' + child.id, admin.token, { name: 'لنت خودرو' })
  })

  const shipping = { name: 'خریدار', phone: '09123456789', address: 'تهران، خیابان نمونه', postalCode: '1234567890' }
  let order: any
  await t.test('checkout uses server prices, snapshots and all-or-nothing stock changes', async () => {
    await request('POST', '/orders', customer.token, { ...shipping, items: [{ productId: product.id, quantity: 1 }, { productId: second.id, quantity: 99 }] }, 409)
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock, 3)
    order = await request('POST', '/orders', customer.token, { ...shipping, items: [{ productId: product.id, quantity: 1 }, { productId: second.id, quantity: 2 }] }, 201)
    assert.equal(order.total, 1050000)
    assert.equal(order.paymentMethod, 'COD')
    assert.equal(order.items.length, 2)
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock, 2)
    await request('PATCH', '/vendor/products/' + product.id, vendor.token, { price: 900000, name: 'نام جدید' })
    const snapshot = await request('GET', '/orders/' + order.id, customer.token)
    assert.equal(snapshot.items.find((i: any) => i.productId === product.id).price, 850000)
    assert.equal(snapshot.items.find((i: any) => i.productId === product.id).name, listing.name)
    await request('PATCH', '/admin/products/' + product.id, admin.token, { status: 'ACTIVE' })
    await request('GET', '/orders/' + order.id, stranger.token, undefined, 404)
  })

  await t.test('vendors see only their items; cancellation restocks once; fulfillment is per vendor', async () => {
    const own = (await request('GET', '/vendor/orders', vendor.token))[0]
    assert.equal(own.items.length, 1)
    assert.equal(own.total, 850000)
    assert.equal('user' in own, false)
    assert.equal((await request('GET', '/orders/' + order.id, otherVendor.token)).items.length, 1)
    await request('PATCH', '/vendor/orders/' + order.id, vendor.token, { status: 'CANCELLED' })
    await request('PATCH', '/vendor/orders/' + order.id, vendor.token, { status: 'CANCELLED' })
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock, 3)
    await request('PATCH', '/vendor/orders/' + order.id, vendor.token, { status: 'PROCESSING' }, 409)
    await request('PATCH', '/vendor/orders/' + order.id, otherVendor.token, { status: 'SHIPPED' }, 409)
    await request('PATCH', '/vendor/orders/' + order.id, otherVendor.token, { status: 'PROCESSING' })
    await request('PATCH', '/vendor/orders/' + order.id, otherVendor.token, { status: 'SHIPPED' })
    await request('PATCH', '/vendor/orders/' + order.id, otherVendor.token, { status: 'DELIVERED' })
    assert.equal((await request('GET', '/orders/' + order.id, customer.token)).status, 'DELIVERED')
    assert.equal((await request('GET', '/vendor/dashboard', otherVendor.token)).stats.revenue, 200000)
    assert.equal((await request('GET', '/admin/dashboard', admin.token)).stats.revenue, 200000)
  })

  await t.test('concurrent checkout cannot oversell; concurrent admin cancellation restocks exactly once', async () => {
    await request('PATCH', '/vendor/products/' + product.id, vendor.token, { stock: 1 })
    const attempts = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/orders', headers: { authorization: `Bearer ${customer.token}` }, payload: { ...shipping, items: [{ productId: product.id, quantity: 1 }] } })))
    assert.deepEqual(attempts.map(r => r.statusCode).sort(), [201, 409])
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock, 0)
    const id = attempts.find(r => r.statusCode === 201)!.json().id
    await Promise.all([1, 2].map(() => request('PATCH', '/admin/orders/' + id, admin.token, { status: 'CANCELLED' })))
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock, 1)
  })

  await t.test('suspension hides active products and revokes sessions; legacy products remain public', async () => {
    await request('PATCH', '/admin/users/' + vendor.user.id, admin.token, { status: 'SUSPENDED' })
    await request('GET', '/auth/me', vendor.token, undefined, 401)
    await request('GET', '/products/' + product.slug, undefined, undefined, 404)
    await request('POST', '/orders', customer.token, { ...shipping, items: [{ productId: product.id, quantity: 1 }] }, 409)
    const legacy = await db.product.create({ data: { name: 'قدیمی', sku: 'LEGACY', slug: 'legacy', description: '', price: 50000, stock: 1, brand: 'پارس', image: '/test.svg', tags: [], categoryId: category.id } })
    assert.equal((await request('GET', '/products/' + legacy.slug)).vendor, null)
    await request('POST', '/auth/logout', customer.token)
    await request('GET', '/auth/me', customer.token, undefined, 401)
  })

  await t.test('Persian seed is idempotent, preserves stock/prices and creates no default accounts', async () => {
    const usersBefore = await db.user.count()
    cli('node_modules/tsx/dist/cli.mjs', ['prisma/seed.ts'])
    const seeded = await db.product.findUniqueOrThrow({ where: { sku: 'BRK-132-001' } })
    assert.equal(seeded.price.toNumber(), 850000)
    await db.product.update({ where: { id: seeded.id }, data: { stock: 2, price: 777777 } })
    const count = await db.product.count()
    cli('node_modules/tsx/dist/cli.mjs', ['prisma/seed.ts'])
    assert.equal(await db.product.count(), count)
    assert.equal(await db.user.count(), usersBefore)
    const unchanged = await db.product.findUniqueOrThrow({ where: { id: seeded.id } })
    assert.equal(unchanged.stock, 2)
    assert.equal(unchanged.price.toNumber(), 777777)
  })
})
