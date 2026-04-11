from time import perf_counter

import requests
from fastapi import FastAPI, HTTPException, Request, status

from .config import dedupe_labels, get_settings
from .moderation import ModerationEngine, clamp_threshold, fetch_remote_image
from .schemas import LabelScore, ModerateRequest, ModerateResponse

settings = get_settings()
engine = ModerationEngine(settings)

app = FastAPI(
    title=settings.app_name,
    version='1.0.0',
    docs_url='/docs',
    redoc_url='/redoc'
)


@app.on_event('startup')
def warm_up_models() -> None:
    try:
        engine.ensure_models()
    except Exception:
        # Service still starts even if models fail; /health and /moderate expose the state.
        pass


def _extract_api_key(request: Request) -> str:
    x_api_key = str(request.headers.get('x-api-key', '')).strip()
    if x_api_key:
        return x_api_key

    auth = str(request.headers.get('authorization', '')).strip()
    if auth.lower().startswith('bearer '):
        return auth[7:].strip()

    return ''


def _authorize_request(request: Request) -> None:
    expected = str(settings.moderation_api_key or '').strip()
    if not expected:
        return

    provided = _extract_api_key(request)
    if provided != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Unauthorized'
        )


@app.get('/')
def root() -> dict:
    return {
        'service': settings.app_name,
        'status': 'ok',
        'docs': '/docs'
    }


@app.get('/health')
def health() -> dict:
    model_status = engine.model_status
    return {
        'status': 'ok',
        'environment': settings.app_env,
        'ready': bool(model_status.get('nsfw') or model_status.get('zeroShot')),
        'modelStatus': model_status,
        'defaultThreshold': clamp_threshold(settings.default_threshold),
        'blockedLabels': settings.blocked_labels
    }


@app.post('/moderate', response_model=ModerateResponse)
def moderate(payload: ModerateRequest, request: Request) -> ModerateResponse:
    _authorize_request(request)

    image_url = payload.resolve_image_url()
    if not image_url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='imageUrl is required')

    blocked_labels = dedupe_labels(payload.resolve_blocked_labels(settings.blocked_labels))
    if not blocked_labels:
        blocked_labels = settings.blocked_labels

    requested_threshold = payload.threshold if payload.threshold is not None else settings.default_threshold
    threshold = clamp_threshold(requested_threshold)

    engine.ensure_models()
    if not engine.has_any_model:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Moderation models are unavailable'
        )

    started = perf_counter()
    try:
        image = fetch_remote_image(
            image_url=image_url,
            timeout_seconds=settings.request_timeout_seconds,
            max_image_mb=settings.max_image_mb,
            max_image_pixels=settings.max_image_pixels
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unable to fetch image URL: {exc}'
        ) from exc

    moderation = engine.moderate(image=image, threshold=threshold, blocked_labels=blocked_labels)
    processing_ms = max(1, int((perf_counter() - started) * 1000))

    labels = [
        LabelScore(label=item['label'], score=round(float(item['score']), 6))
        for item in moderation.get('labels', [])
    ]
    matched_categories = [
        LabelScore(label=item['label'], score=round(float(item['score']), 6))
        for item in moderation.get('matchedCategories', [])
    ]
    safe = bool(moderation.get('safe', True))

    return ModerateResponse(
        safe=safe,
        unsafe=not safe,
        isSafe=safe,
        isUnsafe=not safe,
        threshold=threshold,
        blockedLabels=blocked_labels,
        labels=labels,
        matchedCategories=matched_categories,
        processingMs=processing_ms,
        reason=str(moderation.get('reason', 'ok')),
        modelStatus=engine.model_status
    )


@app.get('/moderate')
def moderate_get() -> dict:
    """
    Lightweight GET endpoint for quick browser checks.
    The real moderation endpoint accepts POST JSON payloads (see /docs).
    """
    return {
        "status": "ok",
        "message": "Moderation service is running. Use POST /moderate with JSON {\"imageUrl\": \"...\"} to perform checks.",
    }
