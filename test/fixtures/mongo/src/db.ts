import { PrismaClient } from "@prisma/client";
import { withAccelerate as accelerate } from "@prisma/extension-accelerate";

export const prisma = new PrismaClient().$extends(accelerate());
