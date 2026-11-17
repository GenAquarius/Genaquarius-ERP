"""Build the QA/staging deployment zip (Kudu-compatible, standard zipfile).
Includes: dist, client-dist, node_modules (pruned), prisma, package.json.
Excludes: secrets (.env*), source, the Windows prisma engine, the prisma CLI and
@prisma/engines (CLI-only, not needed at runtime), caches, tmp files.
"""
import os, zipfile, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "deploy-stg.zip")

INCLUDE_TOP = ["dist", "client-dist", "prisma", "package.json", "node_modules", "assets"]

# Path fragments (relative, posix-style) to skip entirely.
SKIP_DIR_FRAGS = [
    "node_modules/prisma/",            # the Prisma CLI (dev only)
    "node_modules/@prisma/engines/",   # CLI engine downloads (runtime uses .prisma/client)
    "node_modules/.cache/",
    "node_modules/.bin/",
    "node_modules/typescript/",        # dev only
    "node_modules/ts-node/",           # dev only
    "node_modules/ts-node-dev/",       # dev only
    "node_modules/@types/",            # dev only
]
SKIP_NAME_FRAGS = [
    "query_engine-windows.dll.node",   # Windows engine + its .tmp* leftovers
    ".env",                            # never ship secrets; Azure uses app settings
]

def skip(rel):
    p = rel.replace("\\", "/")
    if any(frag in p for frag in SKIP_DIR_FRAGS):
        return True
    base = os.path.basename(p)
    if any(frag in base for frag in SKIP_NAME_FRAGS):
        return True
    return False

count = 0
if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for top in INCLUDE_TOP:
        full = os.path.join(ROOT, top)
        if os.path.isfile(full):
            z.write(full, top)
            count += 1
            continue
        for dirpath, dirnames, filenames in os.walk(full):
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                rel = os.path.relpath(fp, ROOT)
                if skip(rel):
                    continue
                z.write(fp, rel)
                count += 1

size_mb = os.path.getsize(OUT) / (1024 * 1024)
print(f"Wrote {OUT}")
print(f"Files: {count}   Size: {size_mb:.1f} MB")
