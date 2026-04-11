from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_BLOCKED_LABELS_CSV = (
    'adult,nsfw,porn,hentai,nudity,sexual,sexy,violence,blood,gore,graphic,weapon,harassment,abuse,hate'
)


def normalize_label(value: str) -> str:
    text = str(value or '').strip().lower()
    if not text:
        return ''

    cleaned_chars = []
    for char in text:
        if char.isalnum() or char in {' ', '-', '_'}:
            cleaned_chars.append(char)
        else:
            cleaned_chars.append(' ')

    cleaned = ''.join(cleaned_chars).replace('_', ' ').replace('-', ' ')
    return ' '.join(cleaned.split())


def dedupe_labels(values: list[str]) -> list[str]:
    seen = set()
    out = []
    for item in values:
        normalized = normalize_label(item)
        if not normalized:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file='.env',
        env_file_encoding='utf-8',
        case_sensitive=False,
        extra='ignore'
    )

    app_name: str = Field(default='ChitZ Image Moderation Service', alias='APP_NAME')
    app_env: str = Field(default='development', alias='APP_ENV')
    moderation_api_key: str = Field(default='', alias='MODERATION_API_KEY')

    default_threshold: float = Field(default=0.72, alias='DEFAULT_THRESHOLD')
    blocked_labels_csv: str = Field(default=DEFAULT_BLOCKED_LABELS_CSV, alias='BLOCKED_LABELS')

    request_timeout_seconds: float = Field(default=8.0, alias='REQUEST_TIMEOUT_SECONDS')
    max_image_mb: int = Field(default=12, alias='MAX_IMAGE_MB')
    max_image_pixels: int = Field(default=16_000_000, alias='MAX_IMAGE_PIXELS')

    enable_nsfw_model: bool = Field(default=True, alias='ENABLE_NSFW_MODEL')
    enable_zero_shot_model: bool = Field(default=True, alias='ENABLE_ZERO_SHOT_MODEL')
    nsfw_model_id: str = Field(default='Falconsai/nsfw_image_detection', alias='NSFW_MODEL_ID')
    zero_shot_model_id: str = Field(default='openai/clip-vit-base-patch32', alias='ZERO_SHOT_MODEL_ID')
    hf_device: int = Field(default=-1, alias='HF_DEVICE')

    @property
    def blocked_labels(self) -> list[str]:
        raw = str(self.blocked_labels_csv or '')
        values = [item.strip() for item in raw.split(',')]
        out = dedupe_labels(values)
        return out if out else dedupe_labels(DEFAULT_BLOCKED_LABELS_CSV.split(','))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
