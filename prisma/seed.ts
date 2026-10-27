import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/security.js'
const prisma = new PrismaClient()

const categories = [
  { name: 'موتور و انتقال قدرت', slug: 'engine-drivetrain', sortOrder: 1 },
  { name: 'سیستم ترمز', slug: 'braking-system', sortOrder: 2 },
  { name: 'تعلیق و فرمان', slug: 'suspension-steering', sortOrder: 3 },
  { name: 'برق و روشنایی', slug: 'electrical-lighting', sortOrder: 4 },
  { name: 'بدنه و قطعات بیرونی', slug: 'body-exterior', sortOrder: 5 },
  { name: 'کابین و رفاهی', slug: 'interior-comfort', sortOrder: 6 },
  { name: 'سرویس و نگهداری', slug: 'maintenance-fluids', sortOrder: 7 },
]
async function main() {
  const password = process.env.SEED_DEMO_PASSWORD
  if (password && (password.length < 10 || password.length > 128)) throw new Error('SEED_DEMO_PASSWORD must be 10–128 characters')
  const createdCategories = new Map<string, string>()
  for (const data of categories) {
    const category = await prisma.category.upsert({ where: { slug: data.slug }, update: {}, create: data })
    createdCategories.set(data.slug, category.id)
  }
  const make = await prisma.vehicleMake.upsert({ where: { slug: 'saipa' }, update: {}, create: { name: 'سایپا', slug: 'saipa', type: 'CAR' } })
  const model = await prisma.vehicleModel.upsert({ where: { makeId_slug: { makeId: make.id, slug: 'pride' } }, update: {}, create: { makeId: make.id, name: 'پراید', slug: 'pride', yearFrom: 1993, yearTo: 2020 } })
  const variants = []
  for (const data of [
    { name: 'پراید ۱۳۲', slug: 'pride-132', engine: '1.3L M13', years: '2008–2019' },
    { name: 'پراید ۱۱۱', slug: 'pride-111', engine: '1.3L M13', years: '2004–2019' },
    { name: 'پراید صبا', slug: 'pride-saba', engine: '1.3L M13', years: '1993–2005' },
  ]) variants.push(await prisma.vehicleVariant.upsert({ where: { modelId_slug: { modelId: model.id, slug: data.slug } }, update: {}, create: { ...data, modelId: model.id } }))
  let vendorId: string | undefined
  if (password) {
    const passwordHash = await hashPassword(password)
    for (const account of [
      { email: 'customer@pluck.local', name: 'مشتری نمونه', role: 'CUSTOMER' as const },
      { email: 'vendor@pluck.local', name: 'فروشنده نمونه', role: 'VENDOR' as const, shopName: 'قطعات یدکی نمونه' },
      { email: 'admin@pluck.local', name: 'مدیر نمونه', role: 'ADMIN' as const },
    ]) {
      const existing = await prisma.user.findUnique({ where: { email: account.email } })
      // Never overwrite existing credentials, roles or approval decisions.
      const user = existing ?? await prisma.user.create({ data: { ...account, passwordHash, status: 'ACTIVE' } })
      if (user.role === 'VENDOR' && user.status === 'ACTIVE') vendorId = user.id
    }
  }
  const products = [
    { sku: 'BRK-132-001', name: 'لنت ترمز جلو سرامیکی پراید', slug: 'premium-ceramic-brake-pad-set', price: 850000, compareAt: 980000, stock: 18, brand: 'پارس', image: '/products/brake-pad.svg', category: 'braking-system' },
    { sku: 'ENG-132-014', name: 'کیت تسمه تایم موتور پراید M13', slug: 'm13-timing-belt-kit', price: 1450000, compareAt: 1680000, stock: 7, brand: 'Gates', image: '/products/timing-belt.svg', category: 'engine-drivetrain' },
    { sku: 'SUS-132-006', name: 'ست بوش جلوبندی پراید', slug: 'front-suspension-bushing-set', price: 620000, stock: 26, brand: 'Febest', image: '/products/bushing.svg', category: 'suspension-steering' },
    { sku: 'ELC-132-003', name: 'جفت چراغ جلو LED پراید', slug: 'led-headlight-upgrade-pair', price: 2150000, compareAt: 2490000, stock: 12, brand: 'Osram', image: '/products/headlight.svg', category: 'electrical-lighting' },
    { sku: 'MNT-132-021', name: 'بسته روغن و فیلتر پراید', slug: 'oil-filter-service-bundle', price: 1120000, stock: 42, brand: 'بهران', image: '/products/service.svg', category: 'maintenance-fluids' },
    { sku: 'BDY-132-011', name: 'آینه بغل چپ پراید', slug: 'door-mirror-assembly-left', price: 480000, stock: 5, brand: 'سایپا', image: '/products/mirror.svg', category: 'body-exterior' },
  ]
  for (const { category, ...data } of products) {
    await prisma.product.upsert({ where: { sku: data.sku }, update: {}, create: {
      ...data, description: `${data.name}، مناسب مدل‌های پراید با کیفیت استاندارد و ضمانت اصالت کالا.`,
      categoryId: createdCategories.get(category)!, vendorId, status: 'ACTIVE', tags: [],
      specifications: { create: [{ name: 'سازگاری', value: 'پراید' }, { name: 'واحد قیمت', value: 'تومان' }] },
      fitments: { create: variants.map(variant => ({ variantId: variant.id })) },
    } })
  }
  console.log(`Seed complete (non-destructive). Demo accounts ${password ? 'enabled for new accounts only' : 'not created'}. Prices are actual toman.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => prisma.$disconnect())
