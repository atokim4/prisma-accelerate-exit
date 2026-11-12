import { prisma } from "./lib/prisma";

export async function listUsers() {
  return prisma.user.findMany({
    where: { name: { not: null } },
    cacheStrategy: { ttl: 60, swr: 30, tags: ["users"] },
  });
}

export async function countUsers() {
  return prisma.user.count({ cacheStrategy: { ttl: 300 } });
}

export async function renameUser(id: number, name: string) {
  const user = await prisma.user.update({ where: { id }, data: { name } });
  await prisma.$accelerate.invalidate({ tags: ["users"] });
  return user;
}
