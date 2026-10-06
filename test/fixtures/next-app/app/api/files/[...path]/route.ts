export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return Response.json({ path: (await params).path });
}
