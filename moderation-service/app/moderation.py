from __future__ import annotations

import threading
from io import BytesIO

import requests
from PIL import Image, UnidentifiedImageError
from transformers import pipeline

from .config import Settings, dedupe_labels, normalize_label


def clamp_threshold(value: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.72
    return max(0.0, min(1.0, numeric))


def label_matches_blocked(candidate_label: str, blocked_labels: list[str]) -> bool:
    candidate = normalize_label(candidate_label)
    if not candidate:
        return False

    for blocked in blocked_labels:
        token = normalize_label(blocked)
        if not token:
            continue
        if candidate == token:
            return True
        if len(token) >= 4 and token in candidate:
            return True
    return False


def merge_label_scores(entries: list[dict]) -> list[dict]:
    by_label = {}
    for item in entries:
        label = normalize_label(item.get('label', ''))
        if not label:
            continue
        try:
            score = float(item.get('score', 0.0))
        except (TypeError, ValueError):
            continue
        score = max(0.0, min(1.0, score))
        prev = by_label.get(label)
        if prev is None or score > prev:
            by_label[label] = score

    merged = [{'label': label, 'score': score} for label, score in by_label.items()]
    merged.sort(key=lambda item: item['score'], reverse=True)
    return merged


def fetch_remote_image(
    image_url: str,
    timeout_seconds: float,
    max_image_mb: int,
    max_image_pixels: int
) -> Image.Image:
    url = str(image_url or '').strip()
    if not url:
        raise ValueError('imageUrl is required')
    if not url.lower().startswith(('http://', 'https://')):
        raise ValueError('Only http/https image URLs are supported')

    max_bytes = max(1, int(max_image_mb)) * 1024 * 1024
    response = requests.get(
        url,
        stream=True,
        timeout=(3.5, float(timeout_seconds)),
        headers={
            'User-Agent': 'ChitZ-Moderation-Service/1.0'
        }
    )
    response.raise_for_status()

    content_type = str(response.headers.get('content-type', '')).lower()
    if content_type and not content_type.startswith('image/'):
        raise ValueError(f'URL does not point to an image (content-type: {content_type})')

    blob = bytearray()
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        blob.extend(chunk)
        if len(blob) > max_bytes:
            raise ValueError(f'Image too large (>{max_image_mb} MB)')

    if not blob:
        raise ValueError('Image download failed (empty body)')

    try:
        image = Image.open(BytesIO(blob))
        image.load()
    except UnidentifiedImageError as exc:
        raise ValueError('Downloaded file is not a valid image') from exc

    pixels = int(image.width) * int(image.height)
    if pixels > int(max_image_pixels):
        raise ValueError(f'Image resolution too large ({pixels} pixels)')

    return image.convert('RGB')


class ModerationEngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self._models_initialized = False
        self._nsfw_pipe = None
        self._zero_shot_pipe = None

    @property
    def model_status(self) -> dict[str, bool]:
        return {
            'nsfw': self._nsfw_pipe is not None,
            'zeroShot': self._zero_shot_pipe is not None
        }

    @property
    def has_any_model(self) -> bool:
        status = self.model_status
        return bool(status['nsfw'] or status['zeroShot'])

    def ensure_models(self) -> None:
        if self._models_initialized:
            return

        with self._lock:
            if self._models_initialized:
                return

            if self.settings.enable_nsfw_model:
                try:
                    self._nsfw_pipe = pipeline(
                        task='image-classification',
                        model=self.settings.nsfw_model_id,
                        device=int(self.settings.hf_device),
                        top_k=8
                    )
                except Exception:
                    self._nsfw_pipe = None

            if self.settings.enable_zero_shot_model:
                try:
                    self._zero_shot_pipe = pipeline(
                        task='zero-shot-image-classification',
                        model=self.settings.zero_shot_model_id,
                        device=int(self.settings.hf_device)
                    )
                except Exception:
                    self._zero_shot_pipe = None

            self._models_initialized = True

    def _collect_nsfw_predictions(self, image: Image.Image) -> list[dict]:
        if self._nsfw_pipe is None:
            return []

        try:
            raw = self._nsfw_pipe(image)
        except Exception:
            return []

        if isinstance(raw, dict):
            predictions = [raw]
        else:
            predictions = list(raw or [])

        mapped = []
        for item in predictions:
            label = normalize_label(item.get('label', ''))
            if not label:
                continue
            try:
                score = float(item.get('score', 0.0))
            except (TypeError, ValueError):
                continue

            mapped.append({'label': label, 'score': score})

            if 'nsfw' in label:
                mapped.append({'label': 'nsfw', 'score': score})
            if 'porn' in label:
                mapped.append({'label': 'porn', 'score': score})
            if 'hentai' in label:
                mapped.append({'label': 'hentai', 'score': score})
            if 'sexy' in label:
                mapped.append({'label': 'sexy', 'score': score})

        return mapped

    def _collect_zero_shot_predictions(self, image: Image.Image, blocked_labels: list[str]) -> list[dict]:
        if self._zero_shot_pipe is None:
            return []

        candidate_labels = dedupe_labels(blocked_labels + ['safe content', 'normal photo', 'everyday scene'])
        if not candidate_labels:
            return []

        try:
            raw = self._zero_shot_pipe(image, candidate_labels=candidate_labels, multi_label=True)
        except Exception:
            return []

        labels = raw.get('labels', []) if isinstance(raw, dict) else []
        scores = raw.get('scores', []) if isinstance(raw, dict) else []
        out = []
        for label, score in zip(labels, scores):
            normalized = normalize_label(label)
            if not normalized:
                continue
            try:
                out.append({'label': normalized, 'score': float(score)})
            except (TypeError, ValueError):
                continue
        return out

    def moderate(self, image: Image.Image, threshold: float, blocked_labels: list[str]) -> dict:
        self.ensure_models()

        entries = []
        entries.extend(self._collect_nsfw_predictions(image))
        entries.extend(self._collect_zero_shot_predictions(image, blocked_labels))

        labels = merge_label_scores(entries)
        threshold_clamped = clamp_threshold(threshold)

        matched_categories = [
            item for item in labels
            if item.get('score', 0.0) >= threshold_clamped and label_matches_blocked(item.get('label', ''), blocked_labels)
        ]

        safe = len(matched_categories) == 0
        reason = 'unsafe-detected' if not safe else ('safe' if labels else 'no-signal')

        return {
            'safe': safe,
            'reason': reason,
            'labels': labels,
            'matchedCategories': matched_categories
        }
