import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PrismaClient, type VehicleBody, type VehicleFuel, type MarketStatus } from '@prisma/client'

const prisma = new PrismaClient()
const here = dirname(fileURLToPath(import.meta.url))

type RawVehicle = {
  make: string
  model: string
  variant: string
  fa_name: string
  manufacturer: string
  body: string
  engine: string
  displacement_cc: number | null
  transmission: string
  drive: string
  fuel: string
  market_status: string
}

const bodyMap: Record<string, VehicleBody> = {
  sedan: 'SEDAN',
  hatchback: 'HATCHBACK',
  crossover: 'CROSSOVER',
  suv: 'SUV',
  pickup: 'PICKUP',
  fastback: 'FASTBACK',
  van: 'VAN',
  coupe: 'COUPE',
}

const fuelMap: Record<string, VehicleFuel> = {
  gasoline: 'GASOLINE',
  diesel: 'DIESEL',
  hybrid: 'HYBRID',
  electric: 'ELECTRIC',
  cng: 'CNG',
}

const toBody = (value: string): VehicleBody | null => bodyMap[value.trim().toLowerCase()] ?? 'OTHER'

const toFuel = (value: string): VehicleFuel | null => {
  const parts = value.split('/').map(p => p.trim().toLowerCase())
  for (const p of parts) if (fuelMap[p]) return fuelMap[p]
  return parts.every(p => !p || p === 'varies') ? null : 'OTHER'
}

const toMarket = (value: string): MarketStatus => {
  if (value.includes('imported')) return 'IMPORTED'
  if (value.includes('assembled')) return 'ASSEMBLED'
  if (value.includes('legacy')) return 'LEGACY'
  if (value.includes('current')) return 'CURRENT'
  return 'OTHER'
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const optional = (value: string): string | null => {
  const trimmed = value.trim()
  return !trimmed || trimmed.toLowerCase() === 'varies' ? null : trimmed
}

const toPersianDigits = (value: string): string => value.replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])

const makeFa: Record<string, string> = {
  Peugeot: 'پژو',
  Samand: 'سمند',
  Dena: 'دنا',
  Tara: 'تارا',
  Arisun: 'آریسان',
  Pride: 'پراید',
  Tiba: 'تیبا',
  Quick: 'کوییک',
  Saina: 'ساینا',
  Shahin: 'شاهین',
  Atlas: 'اطلس',
  Kia: 'کیا',
  JAC: 'جک',
  KMC: 'کی‌ام‌سی',
  MVM: 'ام‌وی‌ام',
  Fidelity: 'فیدلیتی',
  Dignity: 'دیگنیتی',
  Haima: 'هایما',
  Toyota: 'تویوتا',
  Hyundai: 'هیوندای',
  Honda: 'هوندا',
  Nissan: 'نیسان',
  Mitsubishi: 'میتسوبیشی',
  Volkswagen: 'فولکس‌واگن',
  Lamari: 'لاماری',
  BYD: 'بی‌وای‌دی',
  Changan: 'چانگان',
}

const modelFa: Record<string, string> = {
  'Peugeot|206': '۲۰۶',
  'Peugeot|207': '۲۰۷',
  'Peugeot|405': '۴۰۵',
  'Peugeot|Pars': 'پارس',
  'Samand|LX': 'ال‌ایکس',
  'Samand|Soren': 'سورن',
  'Dena|Plus': 'پلاس',
  'Tara|Tara': 'تارا',
  'Arisun|2': 'آریسان ۲',
  'Pride|131': '۱۳۱',
  'Pride|132': '۱۳۲',
  'Pride|111': '۱۱۱',
  'Tiba|Sedan': 'صندوقدار',
  'Tiba|2': 'تیبا ۲',
  'Quick|S': 'اس',
  'Quick|GXR-L': 'جی‌ایکس‌آر-ال',
  'Saina|S': 'اس',
  'Shahin|G': 'جی',
  'Atlas|G': 'جی',
  'Kia|Cerato': 'سراتو',
  'Kia|K3': 'کی۳',
  'Kia|Sportage': 'اسپورتیج',
  'JAC|J4': 'جی۴',
  'JAC|S3': 'اس۳',
  'JAC|S5': 'اس۵',
  'KMC|J7': 'جی۷',
  'KMC|T8': 'تی۸',
  'KMC|X5': 'ایکس۵',
  'MVM|X22': 'ایکس۲۲',
  'MVM|X22 Pro': 'ایکس۲۲ پرو',
  'MVM|X33': 'ایکس۳۳',
  'MVM|X55 Pro': 'ایکس۵۵ پرو',
  'MVM|Arrizo 5': 'آریزو ۵',
  'MVM|Arrizo 6 Pro': 'آریزو ۶ پرو',
  'MVM|Arrizo 6 GT': 'آریزو ۶ جی‌تی',
  'Fidelity|Prime': 'پرایم',
  'Fidelity|Prestige': 'پرستیژ',
  'Dignity|Prime': 'پرایم',
  'Dignity|Prestige': 'پرستیژ',
  'Haima|S5': 'اس۵',
  'Haima|S7': 'اس۷',
  'Haima|8S': '۸اس',
  'Toyota|Corolla': 'کرولا',
  'Toyota|Corolla Cross': 'کرولا کراس',
  'Toyota|RAV4': 'راو۴',
  'Hyundai|Elantra': 'النترا',
  'Hyundai|Tucson': 'توسان',
  'Honda|Civic': 'سیویک',
  'Nissan|Sylphy': 'سیلفی',
  'Mitsubishi|Eclipse Cross': 'اکلیپس کراس',
  'Volkswagen|T-Roc': 'تی-راک',
  'Lamari|Eama': 'ایما',
  'BYD|Han': 'هان',
  'BYD|Seal 06': 'سیل ۰۶',
  'Changan|UNI-Z': 'یونی-زد',
}

async function main() {
  const file = readFileSync(join(here, 'vehicles.data.json'), 'utf8')
  const parsed = JSON.parse(file) as { cars: RawVehicle[] }
  const cars = parsed.cars

  const makeIds = new Map<string, string>()
  const modelKeys = new Map<string, string>()

  let makeCount = 0
  let modelCount = 0
  let variantCount = 0

  for (const car of cars) {
    const makeSlug = slugify(car.make)
    const makeName = makeFa[car.make] ?? car.make
    let makeId = makeIds.get(makeSlug)
    if (!makeId) {
      const make = await prisma.vehicleMake.upsert({
        where: { slug: makeSlug },
        update: { name: makeName, faName: makeName, enName: car.make, manufacturer: car.manufacturer },
        create: { name: makeName, slug: makeSlug, type: 'CAR', faName: makeName, enName: car.make, manufacturer: car.manufacturer },
      })
      makeId = make.id
      makeIds.set(makeSlug, makeId)
      makeCount += 1
    }

    const modelSlug = slugify(car.model)
    const modelName = modelFa[`${car.make}|${car.model}`] ?? car.model
    const compositeKey = `${makeId}:${modelSlug}`
    let modelId = modelKeys.get(compositeKey)
    if (!modelId) {
      const model = await prisma.vehicleModel.upsert({
        where: { makeId_slug: { makeId, slug: modelSlug } },
        update: { name: modelName, faName: modelName, enName: car.model, manufacturer: car.manufacturer, body: toBody(car.body), marketStatus: toMarket(car.market_status) },
        create: {
          makeId,
          name: modelName,
          slug: modelSlug,
          faName: modelName,
          enName: car.model,
          manufacturer: car.manufacturer,
          body: toBody(car.body),
          marketStatus: toMarket(car.market_status),
        },
      })
      modelId = model.id
      modelKeys.set(compositeKey, modelId)
      modelCount += 1
    }

    const variantSlug = slugify(car.variant)
    const variantName = toPersianDigits(car.fa_name)
    await prisma.vehicleVariant.upsert({
      where: { modelId_slug: { modelId, slug: variantSlug } },
      update: {
        name: variantName,
        faName: variantName,
        enName: car.variant,
        engine: optional(car.engine),
        displacementCc: car.displacement_cc ?? null,
        transmission: optional(car.transmission),
        drive: optional(car.drive),
        fuel: toFuel(car.fuel),
        body: toBody(car.body),
        marketStatus: toMarket(car.market_status),
      },
      create: {
        modelId,
        name: variantName,
        slug: variantSlug,
        faName: variantName,
        enName: car.variant,
        engine: optional(car.engine),
        displacementCc: car.displacement_cc ?? null,
        transmission: optional(car.transmission),
        drive: optional(car.drive),
        fuel: toFuel(car.fuel),
        body: toBody(car.body),
        marketStatus: toMarket(car.market_status),
      },
    })
    variantCount += 1
  }

  console.log(`Vehicles registered: ${makeCount} makes, ${modelCount} models, ${variantCount} variants`)
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
