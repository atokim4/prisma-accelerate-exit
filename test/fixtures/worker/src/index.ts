import { getPrisma } from "./db";

export default {
  async fetch(_request: Request, env: { DATABASE_URL: string }) {
    const prisma = getPrisma(env.DATABASE_URL);
    return Response.json(await prisma.item.findMany());
  },
};
