import { z } from 'zod'

const text = (max = 200) => z.string().trim().min(1).max(max)
const optionalText = (max = 200) => z.string().trim().max(max).nullable().optional()
export const id = text(128)
export const credentials = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  password: z.string().min(10).max(128),
}).strict()
export const registration = credentials.extend({ name: text(100) }).strict()
export const profile = z.object({ name: text(100).optional(), shopName: optionalText(150), phone: optionalText(30), address: optionalText(2000) }).strict().refine(v => Object.keys(v).length > 0)
export const listing = z.object({
  name: text(200), sku: text(100), description: z.string().trim().max(10000),
  price: z.number().int().positive().max(9_999_999_999), stock: z.number().int().min(0).max(1_000_000),
  brand: text(100), categoryId: id,
  image: z.string().trim().max(2000).refine(v => /^\/(?!\/)/.test(v) || /^https?:\/\//i.test(v), 'نشانی تصویر نامعتبر است'),
  condition: z.enum(['NEW', 'REFURBISHED', 'USED']).default('NEW'), variantIds: z.array(id).max(200).default([]),
}).strict()
export const listingPatch = listing.partial().refine(v => Object.keys(v).length > 0)
export const checkout = z.object({
  items: z.array(z.object({ productId: id, quantity: z.number().int().min(1).max(1000) }).strict()).min(1).max(100),
  name: text(100), phone: z.string().trim().regex(/^[+\d\s()-]{7,30}$/), address: text(2000),
  postalCode: z.string().trim().regex(/^\d{10}$/), note: z.string().trim().max(2000).optional(),
}).strict().refine(v => new Set(v.items.map(i => i.productId)).size === v.items.length, { message: 'کالای تکراری مجاز نیست' })
export const orderStatus = z.object({ status: z.enum(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']) }).strict()
export const category = z.object({ name: text(100), slug: text(150).refine(v => !/[\s/]/.test(v)), description: optionalText(2000), icon: optionalText(100), sortOrder: z.number().int().min(0).max(100000).optional(), parentId: id.nullable().optional() }).strict()
export const query = z.object({
  q: z.string().trim().max(200).optional(), category: text(150).optional(),
  sort: z.enum(['price-asc', 'price-desc', 'newest']).default('newest'),
  page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
  condition: z.enum(['NEW', 'REFURBISHED', 'USED']).optional(),
  vehicleType: z.enum(['CAR', 'MOTORCYCLE', 'TRUCK']).optional(),
  min: z.coerce.number().min(0).max(9_999_999_999).optional(), max: z.coerce.number().min(0).max(9_999_999_999).optional(),
}).refine(v => v.min === undefined || v.max === undefined || v.min <= v.max)
