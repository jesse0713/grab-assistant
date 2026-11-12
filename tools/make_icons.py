"""生成扩展图标：橙色圆角底 + 白色闪电。"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 1024


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def main() -> None:
    base = Image.new("RGB", (S, S), "#ff5a1f")
    pixels = base.load()
    for y in range(S):
        t = y / (S - 1)
        # 顶部偏亮橙，底部偏红橙
        r = int(255 * (1 - t) + 238 * t)
        g = int(122 * (1 - t) + 66 * t)
        b = int(61 * (1 - t) + 16 * t)
        for x in range(S):
            # 左上角稍微提亮，做出柔和的高光
            glow = max(0.0, 1.0 - ((x / S) ** 2 + (y / S) ** 2) ** 0.5)
            pixels[x, y] = (
                min(255, r + int(18 * glow)),
                min(255, g + int(14 * glow)),
                min(255, b + int(8 * glow)),
            )

    # 闪电阴影
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    bolt = [(612, 92), (294, 574), (493, 574), (424, 950), (768, 430), (566, 430)]
    sd.polygon([(x + 10, y + 16) for x, y in bolt], fill=(120, 30, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    base = Image.alpha_composite(base.convert("RGBA"), shadow)

    draw = ImageDraw.Draw(base)
    draw.polygon(bolt, fill=(255, 255, 255, 255))

    mask = rounded_mask(S, int(S * 0.22))
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    for size in (128, 48, 32, 16):
        icon.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")

    print(f"icons written to {OUT}")


if __name__ == "__main__":
    main()
