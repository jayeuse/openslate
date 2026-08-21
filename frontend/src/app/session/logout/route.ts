import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST() {
  const store = await cookies();
  store.delete("openslate_access");
  store.delete("openslate_refresh");
  return new NextResponse(null, { status: 204 });
}
