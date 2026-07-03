# RIYA — Private AI Atelier

RIYA turns a portrait into an interactive fashion canvas. Paint rough makeup
guides, drag couture pieces onto the image, and render the composition as a
photorealistic edit with Google Gemini image models.

## Included

- Paint-on lipstick, blush, shadow, liner, and highlight guides
- Draggable, resizable, and rotatable wardrobe pieces
- Fast editing with Nano Banana Lite (`gemini-3.1-flash-lite-image`)
- Pro editing with Nano Banana Pro (`gemini-3-pro-image`)
- Transparent one-of-one asset generation with `gpt-image-1.5`
- Persistent custom wardrobe storage in IndexedDB
- Original/revision history, before comparison, zoom, and export
- Responsive desktop, tablet, and mobile studio layouts
- Server-only API key handling, file validation, and basic rate limiting

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Create a local environment file and add **fresh** Gemini and OpenAI API keys:

```bash
cp .env.example .env.local
```

```dotenv
GEMINI_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
```

3. Start the studio:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Image flow

Portrait edits send the latest accepted image as the sole clean base, a
contextual after-guide containing makeup strokes and translucent artifact
placements, a separate white-background makeup map when makeup is present, and
up to eight deduplicated artifact references. Fast uses Nano Banana Lite at 1K;
Pro uses Nano Banana Pro at 2K. The closest supported Gemini aspect ratio is
selected from the current accepted image.

Custom pieces use GPT Image 1.5’s native transparent-background generation and
are saved only in the current browser. Source portraits and generated looks
remain in memory for the current session; no application database is used.

## Checks

```bash
npm run lint
npm run build
```
