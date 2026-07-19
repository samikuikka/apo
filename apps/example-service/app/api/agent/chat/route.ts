import { NextResponse } from "next/server";
import { handleChat } from "@/lib/agent/service";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await handleChat(body);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
