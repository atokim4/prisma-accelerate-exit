import { listUsers } from "../../../users";

export const runtime = "edge";

export async function GET() {
  return Response.json(await listUsers());
}
