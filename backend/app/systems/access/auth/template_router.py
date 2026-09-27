"""Read-only provider mail templates; the backend never substitutes token values."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from app.core.config.settings import REPOSITORY_ROOT

router = APIRouter(prefix="/auth/email-templates", include_in_schema=False)


@router.get("/{name}", response_class=HTMLResponse)
def email_template(name: str) -> HTMLResponse:
    if name not in {"invite.html", "recovery.html"}:
        raise HTTPException(404, "Template not found")
    try:
        contents = (REPOSITORY_ROOT / "infra" / "supabase" / "templates" / name).read_text(
            encoding="utf-8"
        )
    except OSError:
        raise HTTPException(503, "Email template is unavailable") from None
    return HTMLResponse(contents, headers={"Cache-Control": "no-store"})
