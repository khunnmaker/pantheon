import fitz, os, sys

src = r"G:\My Drive\Shared\Minerva\product-photos\260611_product-catalog.pdf"
out = r"C:\Users\khunn\AppData\Local\Temp\minerva-catalog"
os.makedirs(out, exist_ok=True)

doc = fitz.open(src)
print("pages:", doc.page_count)
dpi = int(sys.argv[1]) if len(sys.argv) > 1 else 200
mat = fitz.Matrix(dpi / 72, dpi / 72)
for i, page in enumerate(doc):
    pix = page.get_pixmap(matrix=mat)
    p = os.path.join(out, f"page-{i + 1:02d}.png")
    pix.save(p)
    print(f"page-{i + 1:02d}.png  {pix.width}x{pix.height}  {os.path.getsize(p) // 1024}KB")
print("done ->", out)
