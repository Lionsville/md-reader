#!/usr/bin/env python3
"""Write a Windows .ico from square PNG files (PNG-compressed frames, Vista+).

Usage: make_ico.py out.ico frame1.png frame2.png ...
"""
import struct
import sys


def png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def main() -> None:
    out, frames = sys.argv[1], sys.argv[2:]
    blobs = []
    for path in frames:
        with open(path, "rb") as f:
            data = f.read()
        w, h = png_size(data)
        if w != h or w > 256:
            raise SystemExit(f"{path}: frames must be square and <= 256 px (got {w}x{h})")
        blobs.append((w, data))
    blobs.sort(key=lambda b: b[0])

    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries, payload = b"", b""
    for size, data in blobs:
        dim = 0 if size == 256 else size  # 0 means 256 in the ICO directory
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    with open(out, "wb") as f:
        f.write(header + entries + payload)


if __name__ == "__main__":
    main()
