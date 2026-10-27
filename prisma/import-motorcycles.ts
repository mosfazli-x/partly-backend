import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PrismaClient, type VehicleBody } from '@prisma/client'

const prisma = new PrismaClient()
const here = dirname(fileURLToPath(import.meta.url))

type RawMoto = {
  make: string
  model: string
  fa_name: string
  displacement_cc: number
  transmission: string
  body: string
  source_group: string
}

const bodyMap: Record<string, VehicleBody> = {
  scooter: 'SCOOTER',
  'maxi scooter': 'MAXI_SCOOTER',
  'adventure scooter': 'ADVENTURE_SCOOTER',
  underbone: 'UNDERBONE',
  naked: 'NAKED',
  standard: 'STANDARD',
  sport: 'SPORT',
  trail: 'TRAIL',
  mini: 'MINI',
  scrambler: 'SCRAMBLER',
  adventure: 'ADVENTURE',
  'neo-retro': 'NEO_RETRO',
  classic: 'CLASSIC',
  cruiser: 'CRUISER',
  touring: 'TOURING',
}

const makeFa: Record<string, string> = {
  TVS: 'TVS',
  Parvaz: 'پرواز',
  Ehsan: 'احسان',
  Daichi: 'دایچی',
  Sahar: 'سحر',
  Galaxy: 'گلکسی',
  Benelli: 'بنلی',
  Keeway: 'کی‌وی',
  Morbidelli: 'موربیدلی',
  'Kavir Motor': 'کویر موتور',
  Kabir: 'کبیر',
  Vespa: 'وسپا',
  Peugeot: 'پژو',
  Honest: 'هونست',
  Honda: 'هوندا',
  Yamaha: 'یاماها',
  Bajaj: 'باجاج',
  SYM: 'SYM',
  CFMoto: 'سی‌اف‌موتو',
  Kawasaki: 'کاوازاکی',
  Suzuki: 'سوزوکی',
  Piaggio: 'پیاجیو',
  Aprilia: 'آپریلیا',
  KTM: 'KTM',
  'Royal Enfield': 'رویال انفیلد',
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const toPersianDigits = (value: string): string => value.replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])

const toBody = (value: string): VehicleBody => bodyMap[value.trim().toLowerCase()] ?? 'OTHER'

async function main() {
  const file = readFileSync(join(here, 'motorcycles.data.json'), 'utf8')
  const parsed = JSON.parse(file) as { motorcycles: RawMoto[] }
  const motos = parsed.motorcycles

  const makeIds = new Map<string, string>()
  const modelKeys = new Map<string, string>()

  let makeCount = 0
  let modelCount = 0
  let variantCount = 0

  for (const moto of motos) {
    const makeSlug = `moto-${slugify(moto.make)}`
    const makeName = makeFa[moto.make] ?? moto.make
    let makeId = makeIds.get(makeSlug)
    if (!makeId) {
      const make = await prisma.vehicleMake.upsert({
        where: { slug: makeSlug },
        update: { name: makeName, faName: makeName, enName: moto.make, type: 'MOTORCYCLE', sourceGroup: moto.source_group },
        create: { name: makeName, slug: makeSlug, type: 'MOTORCYCLE', faName: makeName, enName: moto.make, sourceGroup: moto.source_group },
      })
      makeId = make.id
      makeIds.set(makeSlug, makeId)
      makeCount += 1
    }

    const modelSlug = slugify(moto.model)
    const modelName = toPersianDigits(moto.model)
    const compositeKey = `${makeId}:${modelSlug}`
    let modelId = modelKeys.get(compositeKey)
    if (!modelId) {
      const model = await prisma.vehicleModel.upsert({
        where: { makeId_slug: { makeId, slug: modelSlug } },
        update: { name: modelName, faName: modelName, enName: moto.model, body: toBody(moto.body), sourceGroup: moto.source_group },
        create: { makeId, name: modelName, slug: modelSlug, faName: modelName, enName: moto.model, body: toBody(moto.body), sourceGroup: moto.source_group },
      })
      modelId = model.id
      modelKeys.set(compositeKey, modelId)
      modelCount += 1
    }

    const variantName = toPersianDigits(moto.fa_name)
    await prisma.vehicleVariant.upsert({
      where: { modelId_slug: { modelId, slug: modelSlug } },
      update: {
        name: variantName,
        faName: variantName,
        enName: moto.model,
        body: toBody(moto.body),
        displacementCc: moto.displacement_cc,
        transmission: moto.transmission,
        fuel: 'GASOLINE',
        sourceGroup: moto.source_group,
      },
      create: {
        modelId,
        name: variantName,
        slug: modelSlug,
        faName: variantName,
        enName: moto.model,
        body: toBody(moto.body),
        displacementCc: moto.displacement_cc,
        transmission: moto.transmission,
        fuel: 'GASOLINE',
        sourceGroup: moto.source_group,
      },
    })
    variantCount += 1
  }

  console.log(`Motorcycles registered: ${makeCount} makes, ${modelCount} models, ${variantCount} variants`)
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
