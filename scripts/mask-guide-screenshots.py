"""
Redact sensitive data regions in /public/guide/ja/*.png screenshots.

Operates on the production screenshots that ship with the user manual.
We keep navigation, headers and tabs visible (so users can still recognize
the screen) and overlay a solid dark redaction layer with a centered
"実データはマスキングしています" label over the data-heavy body of each
sensitive page.

Run from project root:
    python scripts/mask-guide-screenshots.py
"""

from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
GUIDE_DIR = ROOT / "public" / "guide" / "ja"

REDACTION_LABEL = "実データはマスキングしています"
LABEL_COLOR = (235, 235, 240)
OVERLAY_FILL = (12, 16, 30)        # opaque dark blue, matches dark UI
BORDER_COLOR = (60, 70, 95)


def _font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        r"C:\\Windows\\Fonts\\YuGothM.ttc",
        r"C:\\Windows\\Fonts\\meiryo.ttc",
        r"C:\\Windows\\Fonts\\msgothic.ttc",
        r"C:\\Windows\\Fonts\\arial.ttf",
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except Exception:  # noqa: BLE001
            continue
    return ImageFont.load_default()


def draw_redaction(img: Image.Image, box: tuple[int, int, int, int], label: str | None) -> None:
    """Paint an opaque rectangle and an optional centered label."""
    draw = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    draw.rectangle((x0, y0, x1, y1), fill=OVERLAY_FILL, outline=BORDER_COLOR, width=2)
    if label:
        font = _font(46)
        tbox = draw.textbbox((0, 0), label, font=font)
        tw, th = tbox[2] - tbox[0], tbox[3] - tbox[1]
        cx = (x0 + x1) // 2 - tw // 2
        cy = (y0 + y1) // 2 - th // 2
        draw.text((cx, cy), label, fill=LABEL_COLOR, font=font)


def mask_image(path: Path, regions: list[tuple[tuple[int, int, int, int], str | None]]) -> None:
    img = Image.open(path).convert("RGB")
    for box, label in regions:
        draw_redaction(img, box, label)
    img.save(path, optimize=True)
    print(f"masked {path.name}")


# Region tables — coordinates are in the source image resolution captured at
# 1440x900 viewport with DPR=1.5 (so files are 2160x1350, except 02-status-ok
# which is full-page 2136x2357).

JOBS: dict[str, list[tuple[tuple[int, int, int, int], str | None]]] = {
    # Self-company sales overview — every value below the sub-tab bar is private.
    "01-overview.png": [
        ((100, 380, 2060, 1340), REDACTION_LABEL),
    ],
    # MD strategy form — only the "分析データプレビュー" panel exposes internals
    # (total revenue, gross margin %, product count, weeks counted, TOP 5
    # internal products, and a category bar chart of sales). Mask just that
    # panel; extend to image bottom so TOP5 row doesn't peek through.
    "05-md-strategy-form.png": [
        ((50, 1040, 2110, 1350), REDACTION_LABEL),
    ],
    # MD strategy result — the entire body below the page tabs cites internal
    # product names, internal margin %, and customer goal text.
    "05b-md-strategy-result.png": [
        ((80, 400, 2080, 1340), REDACTION_LABEL),
    ],
    # Connection-status screen — the UUID in the C package row, the goal text
    # in MD戦略, and the internal/external counts in 統合根拠. All others
    # (status names, OK badges, descriptions) are non-sensitive.
    "02-status-ok.png": [
        # C package UUID line
        ((230, 1330, 1900, 1395), None),
        # MD戦略 goal text
        ((230, 1540, 1900, 1605), None),
        # 統合根拠 internal/external counts
        ((230, 1665, 1900, 1730), None),
    ],
    # Screenplay list — first few titles include both internal and partner
    # products. Cover the title column body only.
    "08-screenplays-list.png": [
        ((130, 360, 1700, 1340), REDACTION_LABEL),
    ],
    # Screenplay detail — pricing copy, internal product context, full ad copy.
    "08b-screenplay-detail.png": [
        ((100, 360, 2060, 1350), REDACTION_LABEL),
    ],
}


def main() -> None:
    for name, regions in JOBS.items():
        path = GUIDE_DIR / name
        if not path.exists():
            print(f"skip (missing): {name}")
            continue
        mask_image(path, regions)


if __name__ == "__main__":
    main()
