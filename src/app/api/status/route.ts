export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      configured: Boolean(
        process.env.GEMINI_API_KEY && process.env.OPENAI_API_KEY,
      ),
      editConfigured: Boolean(process.env.GEMINI_API_KEY),
      assetConfigured: Boolean(process.env.OPENAI_API_KEY),
      fastModel:
        process.env.GEMINI_FAST_IMAGE_MODEL || "gemini-3.1-flash-lite-image",
      proModel: process.env.GEMINI_PRO_IMAGE_MODEL || "gemini-3-pro-image",
      assetModel: process.env.OPENAI_ASSET_MODEL || "gpt-image-1.5",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
