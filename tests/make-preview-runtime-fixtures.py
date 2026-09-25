"""Create synthetic-only PDFs for runtime-preview-rich.js.
Usage: python make-preview-runtime-fixtures.py /private/tmp/ziv-preview-runtime-...
Requires Pillow/reportlab (available in the bundled Codex Python runtime).
"""
from pathlib import Path
from PIL import Image
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader
import io,random,math,json,sys
root=Path(sys.argv[1]).resolve()
assert str(root).startswith('/private/tmp/ziv-preview-runtime-'), 'Use a disposable test directory'
(root/'fixtures').mkdir(parents=True,exist_ok=True)
for i in range(480):
    r=random.Random(i+1809)
    pix=bytearray()
    for y in range(480):
      for x in range(360):
        pix.extend(((x*3+y+i*31+r.randrange(50))%256,(y*2+x+i*67+r.randrange(50))%256,(x+y*3+i*97+r.randrange(50))%256))
    picture=Image.frombytes('RGB',(360,480),bytes(pix))
    encoded=io.BytesIO();picture.save(encoded,'JPEG',quality=88)
    canvas=Canvas(str(root/'fixtures'/f'{i:03}.pdf'),pagesize=(612,792),pageCompression=1)
    canvas.setTitle(f'Synthetic image and vector fixture {i}')
    canvas.drawImage(ImageReader(io.BytesIO(encoded.getvalue())),24,280,width=280,height=370)
    canvas.setFont('Helvetica-Bold',18);canvas.drawString(24,752,f'Synthetic performance fixture {i:03}')
    canvas.setFont('Helvetica',8)
    for row in range(45):canvas.drawString(320,720-row*10,f'Distinct benchmark data {i}-{row}: {r.randrange(10**8)}')
    for k in range(800):
      canvas.setStrokeColorRGB(r.random(),r.random(),r.random());canvas.setLineWidth(.2+r.random())
      canvas.line(r.randrange(24,590),r.randrange(25,260),r.randrange(24,590),r.randrange(25,260))
    canvas.showPage()
    for page in range(4):
      canvas.setFont('Courier',10)
      for line in range(55):canvas.drawString(30,750-line*12,f'Synthetic continuation {i}/{page}/{line}: {r.randrange(10**12)}')
      canvas.showPage()
    canvas.save()
# Larger realistic PDF: 96 separately encoded 900x1100 illustrations, firstpage is simple.
# Its later pages intentionally have high entropy so whole-file I/O is measurable.
large=Canvas(str(root/'fixtures/large.pdf'),pagesize=(612,792),pageCompression=1)
large.setTitle('Synthetic many-page 96-image attachment')
large.setFont('Helvetica-Bold',24);large.drawString(40,730,'Large attachment, simple first page');large.showPage()
r=random.Random(80917)
for page in range(96):
    noise=r.randbytes(900*1100*3);im=Image.frombytes('RGB',(900,1100),noise)
    encoded=io.BytesIO();im.save(encoded,'JPEG',quality=78)
    large.drawImage(ImageReader(io.BytesIO(encoded.getvalue())),20,20,width=572,height=752)
    large.showPage()
large.save()
sizes=[(root/'fixtures'/f'{i:03}.pdf').stat().st_size for i in range(480)]
(root/'fixtures-meta.json').write_text(json.dumps({'count':480,'bytes':sum(sizes),'minBytes':min(sizes),'maxBytes':max(sizes),'largeBytes':(root/'fixtures/large.pdf').stat().st_size},indent=2))
print((root/'fixtures-meta.json').read_text())
