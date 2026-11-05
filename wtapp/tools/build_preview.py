"""Demo verisini gömülü, tek dosyalık önizleme (preview.html) üretir. Kullanım: python tools/build_preview.py"""
import base64, json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = lambda *p: os.path.join(root, *p)
data_dir = sys.argv[1] if len(sys.argv) > 1 else d("state_demo", "data")
demo = {}
for f in os.listdir(data_dir):
    if f.endswith(".json"):
        demo[f"data/{f}"] = json.load(open(os.path.join(data_dir, f)))
html = open(d("docs", "index.html")).read()
js = lambda n: open(d("docs", n)).read().replace("</script", "<\\/script")
icon = base64.b64encode(open(d("docs", "icon-180.png"), "rb").read()).decode()
html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', "")
html = html.replace('href="icon-180.png"', f'href="data:image/png;base64,{icon}"')
html = html.replace('<script src="lw.js"></script>', f"<script>{js('lw.js')}</script>")
html = html.replace('<script src="ind.js"></script>', f"<script>{js('ind.js')}</script>")
html = html.replace('<script src="app.js"></script>',
                    f"<script>window.DEMO={json.dumps(demo, separators=(',', ':'))};</script>\n<script>{js('app.js')}</script>")
open(d("preview.html"), "w").write(html)
print("preview.html", round(len(html) / 1e6, 2), "MB")
