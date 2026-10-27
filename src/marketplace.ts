import { Prisma, type OrderStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { fail } from './security.js'
import { checkout } from './validation.js'
import type { z } from 'zod'

export const publicProductWhere: Prisma.ProductWhereInput = { status: 'ACTIVE', OR: [{ vendorId: null }, { vendor: { is: { status: 'ACTIVE', role: 'VENDOR' } } }] }
export const userSelect = { id: true, name: true, email: true, role: true, status: true, shopName: true, phone: true, address: true } as const
export const vendorSelect = { id: true, name: true, shopName: true } as const
export const productInclude = { category: true, specifications: true, fitments: { include: { variant: { include: { model: { include: { make: true } } } } } }, vendor: { select: vendorSelect } } as const
export const orderInclude = { items: true, user: { select: userSelect } } as const

// Prisma Decimal's default JSON serialization is a string; the API contract uses actual toman numbers.
export function jsonValue(value: unknown): any {
  if (value instanceof Prisma.Decimal) return value.toNumber()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonValue(v)]))
  return value
}
export async function atomic<T>(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(fn, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 }) }
    catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2034' || attempt >= 4) throw e
      await new Promise(resolve => setTimeout(resolve, 15 * 2 ** attempt + Math.random() * 30))
    }
  }
}
const transitions: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['PROCESSING', 'CANCELLED'], PROCESSING: ['SHIPPED', 'CANCELLED'], SHIPPED: ['DELIVERED'], DELIVERED: [], CANCELLED: [],
}
export function canTransition(from: OrderStatus, to: OrderStatus) { return from === to || transitions[from].includes(to) }
export function aggregateStatus(statuses: OrderStatus[]): OrderStatus {
  const live = statuses.filter(s => s !== 'CANCELLED')
  if (!live.length) return 'CANCELLED'
  if (live.every(s => s === 'DELIVERED')) return 'DELIVERED'
  if (live.every(s => s === 'SHIPPED' || s === 'DELIVERED')) return 'SHIPPED'
  if (live.some(s => s !== 'PENDING')) return 'PROCESSING'
  return 'PENDING'
}
export async function createOrder(db: PrismaClient, userId: string, input: z.infer<typeof checkout>) {
  return atomic(db, async tx => {
    const buyer = await tx.user.findUnique({ where: { id: userId } })
    if (!buyer || buyer.status !== 'ACTIVE') fail(403, 'حساب شما فعال نیست')
    const products = await tx.product.findMany({ where: { AND: [publicProductWhere, { id: { in: input.items.map(i => i.productId) } }] } })
    if (products.length !== input.items.length) fail(409, 'برخی کالاها دیگر قابل سفارش نیستند')
    let total = new Prisma.Decimal(0)
    const items: Prisma.OrderItemCreateWithoutOrderInput[] = []
    // Stable lock order reduces checkout deadlocks.
    for (const item of [...input.items].sort((a, b) => a.productId.localeCompare(b.productId))) {
      const product = products.find(p => p.id === item.productId)!
      const changed = await tx.product.updateMany({ where: { id: product.id, stock: { gte: item.quantity }, ...publicProductWhere }, data: { stock: { decrement: item.quantity } } })
      if (changed.count !== 1) fail(409, `موجودی کالای «${product.name}» کافی نیست`)
      total = total.add(product.price.mul(item.quantity))
      items.push({ product: { connect: { id: product.id } }, ...(product.vendorId ? { vendor: { connect: { id: product.vendorId } } } : {}), name: product.name, sku: product.sku, image: product.image, price: product.price, quantity: item.quantity })
    }
    if (total.greaterThan('99999999999999.99')) fail(400, 'مبلغ سفارش بیش از حد مجاز است')
    const { items: _, ...shipping } = input
    return tx.order.create({ data: { ...shipping, userId, total, paymentMethod: 'COD', items: { create: items } }, include: orderInclude })
  })
}
export async function changeOrderStatus(db: PrismaClient, orderId: string, status: OrderStatus, vendorId?: string) {
  return atomic(db, async tx => {
    if (vendorId) {
      const vendor = await tx.user.findUnique({ where: { id: vendorId } })
      if (!vendor || vendor.role !== 'VENDOR' || vendor.status !== 'ACTIVE') fail(403, 'دسترسی فقط برای فروشنده تأییدشده مجاز است')
    }
    const order = await tx.order.findUnique({ where: { id: orderId }, include: orderInclude })
    if (!order) return fail(404, 'سفارش پیدا نشد')
    const items = order.items.filter(i => !vendorId || i.vendorId === vendorId)
    if (!items.length) return fail(404, 'سفارش پیدا نشد')
    // Admin changes target all non-cancelled items; cancelled items are terminal, never resurrected.
    const targets = vendorId ? items : items.filter(i => i.status !== 'CANCELLED')
    if (!targets.length && status !== 'CANCELLED') fail(409, 'سفارش لغو شده قابل تغییر نیست')
    if (targets.some(i => !canTransition(i.status, status))) fail(409, 'تغییر وضعیت سفارش مجاز نیست')
    for (const item of targets.sort((a, b) => a.productId.localeCompare(b.productId))) {
      if (item.status === status) continue
      await tx.orderItem.update({ where: { id: item.id }, data: { status } })
      if (status === 'CANCELLED') await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } })
    }
    const all = await tx.orderItem.findMany({ where: { orderId } })
    return tx.order.update({ where: { id: orderId }, data: { status: aggregateStatus(all.map(i => i.status)) }, include: orderInclude })
  })
}
export function vendorOrder<T extends { items: { vendorId: string | null; price: Prisma.Decimal; quantity: number; status: OrderStatus }[] }>(order: T, vendorId: string) {
  const items = order.items.filter(i => i.vendorId === vendorId)
  // No other vendors' line items, totals, or buyer account details are exposed.
  const { user: _user, ...safe } = order as T & { user?: unknown }
  return { ...safe, items, status: aggregateStatus(items.map(i => i.status)), total: items.reduce((sum, i) => sum.add(i.price.mul(i.quantity)), new Prisma.Decimal(0)) }
}
