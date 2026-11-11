"""Regenerate the small vendored Material Icon Theme sprite from its pinned upstream."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import json
import re
import urllib.request
import xml.etree.ElementTree as ET

COMMIT = "ced21b9b5241c1efa502a8c46ec7363a690a7058"
NAMES = ["typescript","react_ts","javascript","react","json","markdown","css","sass","html","python","yaml","console","rust","go","database","image","pdf","git","docker","lock","settings","document","xml","nodejs","npm","vue","svelte","java","kotlin","c","cpp","csharp","zip","video","audio","font","graphql","terraform","toml","tune","folder-node","folder-src","folder-app","folder-lib","folder-test","folder-git","folder-config","folder-dist","folder-components","folder-docs","folder-public","folder-images","folder-resource","folder-api","folder-scripts","folder-github","toml_light"]
BASE = f"https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/{COMMIT}/"
ROOT = Path(__file__).resolve().parent.parent / "public/file-icons"
OPEN_PATH = "M14.483 6H4.721a1 1 0 0 0-.949.684L2 12V5h12a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232l-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11l2.403-5.606A1 1 0 0 0 14.483 6"
ET.register_namespace("", "http://www.w3.org/2000/svg")

def fetch(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as response:
        return response.read()

def symbol(name, source, opened=False):
    svg = ET.fromstring(source)
    if opened:
        folder = next(node for node in svg.iter() if node.get("id") == "folder")
        folder.set("d", OPEN_PATH)
    svg.tag = "{http://www.w3.org/2000/svg}symbol"
    svg.set("id", name)
    svg.attrib.pop("width", None)
    svg.attrib.pop("height", None)
    for node in svg.iter():
        if node is not svg and node.get("id"):
            node.set("id", name + "-" + node.get("id"))
        for key, value in list(node.attrib.items()):
            node.set(key, re.sub(r"url\(#([^)]*)\)", lambda match: "url(#" + name + "-" + match[1] + ")", value))
    return ET.tostring(svg, encoding="unicode").replace(' xmlns="http://www.w3.org/2000/svg"', "")

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        sources = dict(zip(NAMES, pool.map(lambda name: fetch("icons/" + name + ".svg"), NAMES)))
    symbols = []
    for name, source in sources.items():
        symbols.append(symbol(name, source))
        if name.startswith("folder-"):
            symbols.append(symbol(name + "-open", source, opened=True))
    folder_source = ET.fromstring(sources["folder-src"])
    folder = next(node for node in folder_source.iter() if node.get("id") == "folder")
    generic = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path id="folder" fill="#90a4ae" d="' + folder.get("d") + '"/></svg>'
    symbols.extend([symbol("folder", generic), symbol("folder-open", generic, opened=True)])
    sprite = '<svg xmlns="http://www.w3.org/2000/svg">' + "".join(symbols) + "</svg>\n"
    ROOT.joinpath("material.svg").write_bytes(sprite.encode("utf-8"))
    ROOT.joinpath("LICENSE.txt").write_bytes(fetch("LICENSE"))
    ROOT.joinpath("manifest.json").write_text(json.dumps({
        "upstream": "https://github.com/material-extensions/vscode-material-icon-theme",
        "commit": COMMIT,
        "sources": {name + ".svg": hashlib.sha256(source).hexdigest() for name, source in sources.items()},
        "spriteSha256": hashlib.sha256(sprite.encode()).hexdigest(),
        "symbols": re.findall(r'<symbol[^>]* id="([^"]+)"', sprite),
        "transformations": "SVG symbols with prefixed local ids; open-folder paths from upstream generator; generic folder from folder-src without its motive, filled #90a4ae."
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(sources)} upstream SVGs; {len(sprite.encode())} sprite bytes")

if __name__ == "__main__":
    main()
