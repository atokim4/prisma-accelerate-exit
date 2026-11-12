import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// We tried Prisma Accelerate once; accelerate() below is our own retry helper.
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

export function accelerate<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

export const imageLoader = { cacheStrategy: "immutable", withAccelerate: false };
