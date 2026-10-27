import 'dotenv/config'
import { buildApp } from './app.js'
import { disconnectDatabase, prisma } from './db.js'

const app = await buildApp({ logger: true })
let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  await app.close()
  await disconnectDatabase()
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
try {
  const [database] = await prisma.$queryRaw<{ server_encoding: string }[]>`SHOW server_encoding`
  if (database?.server_encoding !== 'UTF8') {
    throw new Error('The marketplace requires a UTF8 PostgreSQL database for Persian catalog data. Check DATABASE_URL before starting the API.')
  }
  await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' })
} catch (error) {
  app.log.error(error)
  await shutdown()
  process.exitCode = 1
}
