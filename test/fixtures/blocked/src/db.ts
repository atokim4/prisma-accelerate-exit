import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";

export const prisma = new PrismaClient({ accelerateUrl: process.env.DATABASE_URL! }).$extends(withAccelerate());

const cached = { ttl: 60 };

export async function feed() {
  const args = { take: 20, cacheStrategy: cached };
  const { data, info } = await prisma.user.findMany(args).withAccelerateInfo();
  console.log(info?.cacheStatus);
  return data;
}
