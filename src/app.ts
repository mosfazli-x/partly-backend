import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import { Prisma, type PrismaClient } from '@prisma/client'
import { ZodError } from 'zod'
import { marketplaceRoutes } from './routes.js'
import { prisma } from './db.js'
import { HttpError } from './security.js'

export async function buildApp(options: { db?: PrismaClient; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false, bodyLimit: 65536, requestTimeout: 30000 })
  await app.register(helmet)
  await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',').map(v => v.trim()).filter(Boolean) ?? ['http://localhost:3000'], methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'اطلاعات واردشده معتبر نیست؛ فیلدها و مقادیر را بررسی کنید' })
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message })
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') return reply.code(409).send({ message: 'ایمیل، کد کالا یا شناسه واردشده قبلاً ثبت شده است' })
      if (error.code === 'P2025') return reply.code(404).send({ message: 'اطلاعات موردنظر پیدا نشد' })
      if (error.code === 'P2003') return reply.code(400).send({ message: 'اطلاعات مرتبط معتبر نیست' })
      if (error.code === 'P2034' || error.code === 'P2028') return reply.code(409).send({ message: 'تداخل هم‌زمانی رخ داد؛ دوباره تلاش کنید' })
    }
    const status = (error as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.code(status).send({ message: status === 413 ? 'حجم درخواست بیش از حد مجاز است' : 'درخواست معتبر نیست' })
    request.log.error(error)
    return reply.code(503).send({ message: 'سرویس موقتاً در دسترس نیست؛ دوباره تلاش کنید' })
  })
  app.setNotFoundHandler((_r, reply) => reply.code(404).send({ message: 'مسیر موردنظر پیدا نشد' }))
  await marketplaceRoutes(app, options.db ?? prisma)
  return app
}
