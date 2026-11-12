import { PrismaClient } from "@prisma/client/edge";
import { withAccelerate } from "@prisma/extension-accelerate";

export const prisma = new PrismaClient().$extends(withAccelerate());

export async function latestPosts() {
  return prisma.post.findMany({ take: 10, orderBy: { id: "desc" } });
}
