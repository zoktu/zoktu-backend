from pydantic import BaseModel, ConfigDict, Field


class AttachmentInput(BaseModel):
    model_config = ConfigDict(extra='allow')

    url: str | None = None
    fileName: str | None = None
    fileSize: int | None = None
    mimeType: str | None = None
    publicId: str | None = None


class ModerateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra='allow')

    imageUrl: str | None = None
    image_url: str | None = Field(default=None)
    threshold: float | None = None
    blockedLabels: list[str] | None = None
    blocked_labels: list[str] | None = None
    roomId: str | None = None
    senderId: str | None = None
    attachment: AttachmentInput | None = None

    def resolve_image_url(self) -> str:
        candidates = [self.imageUrl, self.image_url, self.attachment.url if self.attachment else None]
        for item in candidates:
            value = str(item or '').strip()
            if value:
                return value
        return ''

    def resolve_blocked_labels(self, fallback: list[str]) -> list[str]:
        if self.blockedLabels:
            return [str(item).strip() for item in self.blockedLabels if str(item).strip()]
        if self.blocked_labels:
            return [str(item).strip() for item in self.blocked_labels if str(item).strip()]
        return list(fallback)


class LabelScore(BaseModel):
    label: str
    score: float


class ModerateResponse(BaseModel):
    safe: bool
    unsafe: bool
    isSafe: bool
    isUnsafe: bool
    threshold: float
    blockedLabels: list[str]
    labels: list[LabelScore]
    matchedCategories: list[LabelScore]
    processingMs: int
    reason: str
    modelStatus: dict[str, bool]
