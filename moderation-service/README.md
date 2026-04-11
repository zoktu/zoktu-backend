# ChitZ Python Image Moderation Service

FastAPI microservice for server-side image moderation.

It exposes:
- `GET /health` → service/model readiness
- `POST /moderate` → classify image as safe/unsafe with category scores

This service is designed to work with `backend/src/lib/imageModeration.js`.

## 1) Quick Start (Local)

1. Create virtual environment and install dependencies.
2. Copy `.env.example` to `.env` and set values if needed.
3. Run Uvicorn.

Example request URL from backend should be:
- `http://127.0.0.1:8000/moderate`

## 2) Request Contract

`POST /moderate`

Accepts payload fields used by backend:
- `imageUrl` or `image_url` (required)
- `threshold` (optional, range 0..1)
- `blockedLabels`/`blocked_labels` (optional)
- `roomId`, `senderId` (optional context)
- `attachment` object (optional)

## 3) Response Contract

Returns both explicit flags + per-label scores:

- `safe` / `unsafe`
- `isSafe` / `isUnsafe`
- `labels`: list of `{ label, score }`
- `matchedCategories`: list of blocked categories above threshold
- `threshold`, `blockedLabels`, `processingMs`, `reason`, `modelStatus`

This format is compatible with your Node moderation parser.

## 4) API Key Protection (Optional)

If `MODERATION_API_KEY` is set, service requires one of:
- `Authorization: Bearer <token>`
- `x-api-key: <token>`

Set same value in backend env:
- `IMAGE_MODERATION_API_KEY=<same_token>`

## 5) Backend Integration

In `backend/.env`:

- `IMAGE_MODERATION_ENABLED=true`
- `IMAGE_MODERATION_SERVICE_URL=http://127.0.0.1:8000/moderate`
- `IMAGE_MODERATION_API_KEY=<optional_same_token>`
- `IMAGE_MODERATION_THRESHOLD=0.72`
- `IMAGE_MODERATION_FAIL_OPEN=true` (or `false` for strict mode)

## 6) Docker

`Dockerfile` is included. Build and run with your preferred container workflow.

## Notes

- First startup may take time due to model download.
- `HF_DEVICE=-1` uses CPU by default.
- For GPU runtime set `HF_DEVICE=0` and use compatible CUDA/PyTorch image.
