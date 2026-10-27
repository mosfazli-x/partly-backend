import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma, type PrismaClient, type User } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fail, hashPassword, verifyPassword, hashToken, newToken } from './security.js'
import * as v from './validation.js'
import { publicProductWhere, userSelect, productInclude, orderInclude, jsonValue, atomic, createOrder, changeOrderStatus, vendorOrder } from './marketplace.js'

declare module 'fastify' { interface FastifyRequest { user: User | null; sessionHash: string | null } }

export async function marketplaceRoutes(app: FastifyInstance, db: PrismaClient) {
  app.decorateRequest('user', null)
  app.decorateRequest('sessionHash', null)
  const auth = async (request: FastifyRequest) => {
    const header = request.headers.authorization
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return fail(401, 'برای ادامه وارد حساب شوید')
    const tokenHash = hashToken(header.slice(7))
    const session = await db.session.findUnique({ where: { tokenHash }, include: { user: true } })
    if (!session || session.expiresAt <= new Date()) return fail(401, 'نشست شما منقضی شده است؛ دوباره وارد شوید')
    if (session.user.status === 'SUSPENDED') return fail(403, 'حساب شما تعلیق شده است')
    request.user = session.user
    request.sessionHash = tokenHash
  }
  const vendor = async (r: FastifyRequest) => {
    await auth(r)
    if (r.user!.role !== 'VENDOR' || r.user!.status !== 'ACTIVE') fail(403, 'دسترسی فقط برای فروشنده تأییدشده مجاز است')
  }
  const admin = async (r: FastifyRequest) => { await auth(r); if (r.user!.role !== 'ADMIN' || r.user!.status !== 'ACTIVE') fail(403, 'دسترسی مدیر الزامی است') }
  const authorized = { preHandler: auth }
  const vendorOnly = { preHandler: vendor }
  const adminOnly = { preHandler: admin }
  const params = (r: FastifyRequest) => z.object({ id: v.id }).parse(r.params).id
  const send = jsonValue
  const sessionFor = async (user: Pick<User, 'id'>) => {
    const token = newToken()
    await db.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 86400000) } })
    const safe = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: userSelect })
    return { token, user: safe }
  }
  // Fixed-window, bounded in-memory throttling before any expensive scrypt work.
  const attempts = new Map<string, { count: number; until: number }>()
  const throttle = async (r: FastifyRequest) => {
    const now = Date.now()
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key)
    const key = r.ip
    let entry = attempts.get(key)
    if (!entry) {
      if (attempts.size >= 10000) fail(429, 'درخواست‌های زیادی ارسال شده است؛ کمی صبر کنید')
      entry = { count: 0, until: now + 60000 }; attempts.set(key, entry)
    }
    if (++entry.count > 20) fail(429, 'درخواست‌های زیادی ارسال شده است؛ کمی صبر کنید')
  }
  const dummyHash = await hashPassword(randomUUID())

  app.get('/health', async () => ({ status: 'ok', service: 'partly-api' }))
  app.post('/api/auth/register', { preHandler: throttle }, async (r, reply) => {
    const input = v.registration.parse(r.body)
    const passwordHash = await hashPassword(input.password)
    const user = await db.user.create({ data: { name: input.name, email: input.email, passwordHash, role: 'CUSTOMER', status: 'ACTIVE' } })
    reply.code(201)
    return sessionFor(user)
  })
  app.post('/api/auth/login', { preHandler: throttle }, async r => {
    const input = v.credentials.parse(r.body)
    const user = await db.user.findUnique({ where: { email: input.email } })
    const valid = await verifyPassword(input.password, user?.passwordHash ?? dummyHash)
    if (!valid || !user) return fail(401, 'ایمیل یا رمز عبور نادرست است')
    if (user.status === 'SUSPENDED') return fail(403, 'حساب شما تعلیق شده است')
    return sessionFor(user)
  })
  app.get('/api/auth/me', authorized, async r => db.user.findUniqueOrThrow({ where: { id: r.user!.id }, select: userSelect }))
  app.post('/api/auth/logout', authorized, async r => { await db.session.deleteMany({ where: { tokenHash: r.sessionHash! } }); return { message: 'از حساب خارج شدید' } })
  app.patch('/api/account', authorized, async r => {
    const input = v.profile.parse(r.body)
    if (input.shopName !== undefined && r.user!.role !== 'VENDOR') fail(403, 'نام فروشگاه فقط برای فروشنده قابل تنظیم است')
    return db.user.update({ where: { id: r.user!.id }, data: input, select: userSelect })
  })

  app.get('/api/vehicle-types', async r => {
    const { type } = z.object({ type: z.enum(['CAR', 'MOTORCYCLE', 'TRUCK']).optional() }).parse(r.query)
    return db.vehicleMake.findMany({ where: type ? { type } : undefined, select: { id: true, name: true, slug: true, type: true, logo: true }, orderBy: { name: 'asc' } })
  })
  app.get('/api/vehicles', async r => {
    const { type } = z.object({ type: z.enum(['CAR', 'MOTORCYCLE', 'TRUCK']).optional() }).parse(r.query)
    return db.vehicleMake.findMany({ where: type ? { type } : undefined, orderBy: { name: 'asc' }, include: { models: { orderBy: { name: 'asc' }, include: { variants: { orderBy: { name: 'asc' } } } } } })
  })
  app.get('/api/vehicles/:makeSlug/models', async r => {
    const { makeSlug } = z.object({ makeSlug: v.id }).parse(r.params)
    const make = await db.vehicleMake.findUnique({ where: { slug: makeSlug }, include: { models: { orderBy: { name: 'asc' }, include: { variants: { orderBy: { name: 'asc' } } } } } })
    return make ?? fail(404, 'سازنده خودرو پیدا نشد')
  })
  app.get('/api/categories', async () => db.category.findMany({ where: { parentId: null }, include: { children: true }, orderBy: { sortOrder: 'asc' } }))
  const productFilter = (input: z.infer<typeof v.query>): Prisma.ProductWhereInput => ({ AND: [publicProductWhere,
    ...(input.q ? [{ OR: ['name', 'sku', 'brand'].map(field => ({ [field]: { contains: input.q, mode: 'insensitive' } })) }] : []),
    ...(input.category ? [{ category: { OR: [{ slug: input.category }, { id: input.category }] } }] : []),
    ...(input.condition ? [{ condition: input.condition }] : []),
    ...(input.min !== undefined || input.max !== undefined ? [{ price: { gte: input.min, lte: input.max } }] : []),
  ] })
  app.get('/api/products', async r => {
    const input = v.query.parse(r.query)
    const where = productFilter(input)
    const orderBy: Prisma.ProductOrderByWithRelationInput[] = input.sort === 'newest' ? [{ createdAt: 'desc' }, { id: 'asc' }] : [{ price: input.sort === 'price-asc' ? 'asc' : 'desc' }, { id: 'asc' }]
    const [products, total] = await db.$transaction([db.product.findMany({ where, include: productInclude, orderBy, take: input.limit, skip: (input.page - 1) * input.limit }), db.product.count({ where })])
    return send({ products, total, page: input.page, pages: Math.ceil(total / input.limit) })
  })
  app.get('/api/products/:slug', async r => {
    const { slug } = z.object({ slug: v.id }).parse(r.params)
    const product = await db.product.findFirst({ where: { AND: [publicProductWhere, { slug }] }, include: productInclude })
    return send(product ?? fail(404, 'کالا پیدا نشد'))
  })
  app.get('/api/catalog/:variantId', async r => {
    const { variantId } = z.object({ variantId: v.id }).parse(r.params)
    const input = v.query.parse(r.query)
    const vehicle = await db.vehicleVariant.findUnique({ where: { id: variantId }, include: { model: { include: { make: true } } } })
    if (!vehicle) return fail(404, 'مدل خودرو پیدا نشد')
    const where: Prisma.ProductWhereInput = { AND: [productFilter(input), { fitments: { some: { variantId } } }] }
    const [products, categories] = await Promise.all([
      db.product.findMany({ where, include: productInclude, orderBy: { createdAt: 'desc' } }),
      db.category.findMany({ where: { products: { some: { AND: [publicProductWhere, { fitments: { some: { variantId } } }] } } }, orderBy: { sortOrder: 'asc' } }),
    ])
    return send({ vehicle, products, categories })
  })
  app.get('/api/search', async r => {
    const { q, type } = z.object({ q: z.string().trim().max(200).optional(), type: z.string().max(30).optional() }).parse(r.query)
    if (!q) return { products: [], vehicles: [] }
    const [products, vehicles] = await Promise.all([
      db.product.findMany({ where: productFilter(v.query.parse({ q })), take: 8, include: productInclude }),
      type === 'products' ? [] : db.vehicleVariant.findMany({ where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { model: { name: { contains: q, mode: 'insensitive' } } }] }, take: 8, include: { model: { include: { make: true } } } }),
    ])
    return send({ products, vehicles })
  })

  app.get('/api/orders', authorized, async r => send(await db.order.findMany({ where: { userId: r.user!.id }, include: orderInclude, orderBy: { createdAt: 'desc' } })))
  app.post('/api/orders', authorized, async (r, reply) => {
    const input = v.checkout.parse(r.body)
    const order = await createOrder(db, r.user!.id, input)
    reply.code(201); return send(order)
  })
  app.get('/api/orders/:id', authorized, async r => {
    const order = await db.order.findUnique({ where: { id: params(r) }, include: orderInclude })
    if (!order) return fail(404, 'سفارش پیدا نشد')
    if (r.user!.role === 'ADMIN' || order.userId === r.user!.id) return send(order)
    if (r.user!.role === 'VENDOR' && r.user!.status === 'ACTIVE' && order.items.some(i => i.vendorId === r.user!.id)) return send(vendorOrder(order, r.user!.id))
    return fail(404, 'سفارش پیدا نشد')
  })

  app.get('/api/vendor/products', vendorOnly, async r => send(await db.product.findMany({ where: { vendorId: r.user!.id }, include: productInclude, orderBy: { createdAt: 'desc' } })))
  const validateRelations = async (tx: Prisma.TransactionClient, input: { categoryId?: string; variantIds?: string[] }) => {
    if (input.categoryId && !await tx.category.findUnique({ where: { id: input.categoryId } })) fail(400, 'دسته‌بندی معتبر نیست')
    if (input.variantIds && (new Set(input.variantIds).size !== input.variantIds.length || await tx.vehicleVariant.count({ where: { id: { in: input.variantIds } } }) !== input.variantIds.length)) fail(400, 'مدل‌های خودرو معتبر نیستند')
  }
  app.post('/api/vendor/products', vendorOnly, async (r, reply) => {
    const input = v.listing.parse(r.body)
    const result = await atomic(db, async tx => {
      await validateRelations(tx, input)
      const { variantIds, ...data } = input
      return tx.product.create({ data: { ...data, slug: `product-${randomUUID()}`, tags: [], vendorId: r.user!.id, status: 'PENDING', fitments: { create: variantIds.map(variantId => ({ variantId })) } }, include: productInclude })
    })
    reply.code(201); return send(result)
  })
  app.patch('/api/vendor/products/:id', vendorOnly, async r => {
    const productId = params(r), input = v.listingPatch.parse(r.body)
    return send(await atomic(db, async tx => {
      const product = await tx.product.findFirst({ where: { id: productId, vendorId: r.user!.id } })
      if (!product) return fail(404, 'کالا پیدا نشد')
      await validateRelations(tx, input)
      const { variantIds, ...data } = input
      const stockOnly = Object.keys(input).every(k => k === 'stock')
      if (variantIds) await tx.productFitment.deleteMany({ where: { productId } })
      return tx.product.update({ where: { id: productId }, data: { ...data, ...(stockOnly ? {} : { status: 'PENDING' }), ...(variantIds ? { fitments: { create: variantIds.map(variantId => ({ variantId })) } } : {}) }, include: productInclude })
    }))
  })
  app.get('/api/vendor/orders', vendorOnly, async r => {
    const orders = await db.order.findMany({ where: { items: { some: { vendorId: r.user!.id } } }, include: orderInclude, orderBy: { createdAt: 'desc' } })
    return send(orders.map(o => vendorOrder(o, r.user!.id)))
  })
  app.patch('/api/vendor/orders/:id', vendorOnly, async r => send(vendorOrder(await changeOrderStatus(db, params(r), v.orderStatus.parse(r.body).status, r.user!.id), r.user!.id)))
  app.get('/api/vendor/dashboard', vendorOnly, async r => {
    const vendorId = r.user!.id
    const [products, orders, lowStock, revenue, recentOrders] = await Promise.all([
      db.product.count({ where: { vendorId } }), db.order.count({ where: { items: { some: { vendorId } } } }), db.product.count({ where: { vendorId, stock: { lte: 5 } } }),
      db.orderItem.findMany({ where: { vendorId, status: 'DELIVERED' }, select: { price: true, quantity: true } }),
      db.order.findMany({ where: { items: { some: { vendorId } } }, take: 5, orderBy: { createdAt: 'desc' }, include: orderInclude }),
    ])
    return send({ stats: { products, orders, lowStock, revenue: revenue.reduce((s, i) => s.add(i.price.mul(i.quantity)), new Prisma.Decimal(0)) }, recentOrders: recentOrders.map(o => vendorOrder(o, vendorId)) })
  })

  app.get('/api/admin/users', adminOnly, async () => db.user.findMany({ select: userSelect, orderBy: { createdAt: 'desc' } }))
  app.patch('/api/admin/users/:id', adminOnly, async r => {
    const userId = params(r), { status } = z.object({ status: z.enum(['ACTIVE', 'PENDING', 'SUSPENDED']) }).strict().parse(r.body)
    return atomic(db, async tx => {
      const user = await tx.user.findUnique({ where: { id: userId } })
      if (!user) return fail(404, 'کاربر پیدا نشد')
      // Administrators cannot be disabled via this public-facing management API.
      if (user.role === 'ADMIN') fail(403, 'تغییر وضعیت مدیر از این مسیر مجاز نیست')
      if (user.role !== 'VENDOR' && status === 'PENDING') fail(400, 'وضعیت در انتظار فقط برای فروشنده مجاز است')
      const result = await tx.user.update({ where: { id: userId }, data: { status }, select: userSelect })
      if (status !== 'ACTIVE') await tx.session.deleteMany({ where: { userId } })
      return result
    })
  })
  app.get('/api/admin/products', adminOnly, async () => send(await db.product.findMany({ include: productInclude, orderBy: { createdAt: 'desc' } })))
  app.patch('/api/admin/products/:id', adminOnly, async r => {
    const { status } = z.object({ status: z.enum(['ACTIVE', 'PENDING', 'REJECTED']) }).strict().parse(r.body)
    return send(await atomic(db, async tx => {
      const product = await tx.product.findUnique({ where: { id: params(r) }, include: { vendor: true } })
      if (!product) return fail(404, 'کالا پیدا نشد')
      if (status === 'ACTIVE' && product.vendor && (product.vendor.status !== 'ACTIVE' || product.vendor.role !== 'VENDOR')) fail(409, 'ابتدا فروشنده را تأیید کنید')
      return tx.product.update({ where: { id: product.id }, data: { status }, include: productInclude })
    }))
  })
  app.get('/api/admin/orders', adminOnly, async () => send(await db.order.findMany({ include: orderInclude, orderBy: { createdAt: 'desc' } })))
  app.patch('/api/admin/orders/:id', adminOnly, async r => send(await changeOrderStatus(db, params(r), v.orderStatus.parse(r.body).status)))
  app.get('/api/admin/dashboard', adminOnly, async () => {
    const [users, vendors, products, orders, pendingProducts, revenue, recentOrders] = await Promise.all([
      db.user.count(), db.user.count({ where: { role: 'VENDOR' } }), db.product.count(), db.order.count(), db.product.count({ where: { status: 'PENDING' } }),
      db.orderItem.findMany({ where: { status: 'DELIVERED' }, select: { price: true, quantity: true } }),
      db.order.findMany({ take: 5, orderBy: { createdAt: 'desc' }, include: orderInclude }),
    ])
    return send({ stats: { users, vendors, products, orders, pendingProducts, revenue: revenue.reduce((s, i) => s.add(i.price.mul(i.quantity)), new Prisma.Decimal(0)) }, recentOrders })
  })
  app.get('/api/admin/categories', adminOnly, async () => db.category.findMany({ include: { children: true }, orderBy: { sortOrder: 'asc' } }))
  app.get('/api/admin/categories/:id', adminOnly, async r => {
    const category = await db.category.findUnique({ where: { id: params(r) }, include: { children: true } })
    return category ?? fail(404, 'دسته‌بندی پیدا نشد')
  })
  const validParent = async (tx: Prisma.TransactionClient, parentId: string | null | undefined, categoryId?: string) => {
    const seen = new Set(categoryId ? [categoryId] : [])
    let current = parentId
    while (current) {
      if (seen.has(current)) return fail(400, 'ساختار دسته‌بندی نباید چرخه داشته باشد')
      seen.add(current)
      const parent = await tx.category.findUnique({ where: { id: current } })
      if (!parent) return fail(400, 'دسته‌بندی والد پیدا نشد')
      current = parent.parentId
    }
  }
  app.post('/api/admin/categories', adminOnly, async (r, reply) => {
    const input = v.category.parse(r.body)
    const result = await atomic(db, async tx => { await validParent(tx, input.parentId); return tx.category.create({ data: input }) })
    reply.code(201); return result
  })
  app.patch('/api/admin/categories/:id', adminOnly, async r => {
    const categoryId = params(r), input = v.category.partial().refine(d => Object.keys(d).length > 0).parse(r.body)
    return atomic(db, async tx => {
      if (!await tx.category.findUnique({ where: { id: categoryId } })) return fail(404, 'دسته‌بندی پیدا نشد')
      await validParent(tx, input.parentId, categoryId)
      return tx.category.update({ where: { id: categoryId }, data: input })
    })
  })
}
