import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Prisma, type PrismaClient } from '@prisma/client'
import { createOrder, changeOrderStatus } from '../src/marketplace.js'

// Transactional in-memory double exercises the service independently of PostgreSQL.
// The separately gated integration suite verifies actual locks and serialization retries.
function fixture() {
  let state: any = {
    products: [
      { id: 'p1', name: 'لنت', sku: 'SKU-1', image: '/pad.svg', price: '850000', stock: 3, vendorId: 'v1', status: 'ACTIVE' },
      { id: 'p2', name: 'فیلتر', sku: 'SKU-2', image: '/filter.svg', price: '100000', stock: 1, vendorId: 'v2', status: 'ACTIVE' },
    ],
    users: [{ id: 'buyer', status: 'ACTIVE', role: 'CUSTOMER' }, { id: 'v1', status: 'ACTIVE', role: 'VENDOR' }],
    orders: [], items: [],
  }
  const db = { $transaction: async (fn: (tx: any) => Promise<any>) => {
    const draft = JSON.parse(JSON.stringify(state))
    const tx = {
      user: { findUnique: async ({ where }: any) => draft.users.find((u: any) => u.id === where.id) ?? null },
      product: {
        findMany: async ({ where }: any) => draft.products.filter((p: any) => where.AND[1].id.in.includes(p.id) && p.status === 'ACTIVE').map((p: any) => ({ ...p, price: new Prisma.Decimal(p.price) })),
        updateMany: async ({ where, data }: any) => {
          const p = draft.products.find((p: any) => p.id === where.id && p.stock >= where.stock.gte && p.status === 'ACTIVE')
          if (!p) return { count: 0 }
          p.stock -= data.stock.decrement
          return { count: 1 }
        },
        update: async ({ where, data }: any) => {
          const p = draft.products.find((p: any) => p.id === where.id)
          p.stock += data.stock.increment
          return p
        },
      },
      order: {
        create: async ({ data }: any) => {
          const { items, ...rest } = data
          const order = { ...rest, id: 'o1', status: 'PENDING' }
          draft.orders.push(order)
          draft.items.push(...items.create.map((i: any, index: number) => {
            const { product, vendor, ...snapshot } = i
            return { ...snapshot, id: `i${index}`, productId: product.connect.id, vendorId: vendor?.connect.id ?? null, orderId: order.id, status: 'PENDING' }
          }))
          return { ...order, items: draft.items }
        },
        findUnique: async ({ where }: any) => {
          const order = draft.orders.find((o: any) => o.id === where.id)
          return order ? { ...order, items: draft.items.filter((i: any) => i.orderId === order.id) } : null
        },
        update: async ({ where, data }: any) => {
          const order = draft.orders.find((o: any) => o.id === where.id)
          Object.assign(order, data)
          return { ...order, items: draft.items.filter((i: any) => i.orderId === order.id) }
        },
      },
      orderItem: {
        update: async ({ where, data }: any) => Object.assign(draft.items.find((i: any) => i.id === where.id), data),
        findMany: async ({ where }: any) => draft.items.filter((i: any) => i.orderId === where.orderId),
      },
    }
    const result = await fn(tx)
    state = draft
    return result
  } } as unknown as PrismaClient
  return { db, state: () => state }
}
const shipping = { name: 'خریدار', phone: '09123456789', address: 'تهران', postalCode: '1234567890' }

test('checkout rolls back all stock decrements if any line is unavailable', async () => {
  const f = fixture()
  await assert.rejects(createOrder(f.db, 'buyer', { ...shipping, items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 2 }] }), { statusCode: 409 })
  assert.deepEqual(f.state().products.map((p: any) => p.stock), [3, 1])
  assert.equal(f.state().orders.length, 0)
  await assert.rejects(createOrder(f.db, 'buyer', { ...shipping, items: [{ productId: 'missing', quantity: 1 }] }), { statusCode: 409 })
})

test('checkout snapshots actual toman prices, calculates totals and rejects inactive buyers', async () => {
  const f = fixture()
  const order = await createOrder(f.db, 'buyer', { ...shipping, items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }] })
  assert.equal(order.total.toNumber(), 1800000)
  assert.equal(order.paymentMethod, 'COD')
  assert.equal(order.items[0].price.toNumber(), 850000)
  assert.deepEqual(f.state().products.map((p: any) => p.stock), [1, 0])
  await assert.rejects(createOrder(f.db, 'unknown', { ...shipping, items: [{ productId: 'p1', quantity: 1 }] }), { statusCode: 403 })
})

test('per-vendor cancellation cannot touch other items and restocks exactly once', async () => {
  const f = fixture()
  await createOrder(f.db, 'buyer', { ...shipping, items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }] })
  await changeOrderStatus(f.db, 'o1', 'CANCELLED', 'v1')
  await changeOrderStatus(f.db, 'o1', 'CANCELLED', 'v1')
  assert.deepEqual(f.state().products.map((p: any) => p.stock), [3, 0])
  assert.deepEqual(f.state().items.map((i: any) => i.status), ['CANCELLED', 'PENDING'])
  assert.equal(f.state().orders[0].status, 'PENDING')
  await assert.rejects(changeOrderStatus(f.db, 'o1', 'PROCESSING', 'v1'), { statusCode: 409 })
  await changeOrderStatus(f.db, 'o1', 'CANCELLED')
  await changeOrderStatus(f.db, 'o1', 'CANCELLED')
  assert.deepEqual(f.state().products.map((p: any) => p.stock), [3, 1])
  assert.equal(f.state().orders[0].status, 'CANCELLED')
})

test('illegal transitions, missing orders and inactive vendors leave state unchanged', async () => {
  const f = fixture()
  await createOrder(f.db, 'buyer', { ...shipping, items: [{ productId: 'p1', quantity: 1 }] })
  await assert.rejects(changeOrderStatus(f.db, 'o1', 'DELIVERED', 'v1'), { statusCode: 409 })
  await assert.rejects(changeOrderStatus(f.db, 'missing', 'CANCELLED'), { statusCode: 404 })
  await assert.rejects(changeOrderStatus(f.db, 'o1', 'CANCELLED', 'unknown'), { statusCode: 403 })
  assert.equal(f.state().items[0].status, 'PENDING')
  assert.equal(f.state().products[0].stock, 2)
})
