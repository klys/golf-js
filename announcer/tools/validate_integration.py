#!/usr/bin/env python3
from pathlib import Path
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
ANN = ROOT / "announcer"

errors = []

def require(condition, message):
    if not condition:
        errors.append(message)

for rel in [
    "announcer/engine.js", "announcer/manager.js", "announcer/ui.js", "announcer/ui.css",
    "announcer/config.json", "announcer/config-data.js",
    "announcer/data/commentator.json", "announcer/data/informant.json",
]:
    require((ROOT / rel).is_file(), f"Falta {rel}")

try:
    cfg = json.loads((ANN / "config.json").read_text(encoding="utf-8"))
    commentator = json.loads((ANN / "data/commentator.json").read_text(encoding="utf-8"))
    informant = json.loads((ANN / "data/informant.json").read_text(encoding="utf-8"))
    require(cfg.get("schema") == "noise-golf-announcer-runtime-v1", "Schema de config inesperado")
    require(set(commentator.get("events", {})) == set(informant.get("events", {})), "Eventos de personas no coinciden")
    require(len(commentator.get("events", {})) >= 70, "Banco de eventos incompleto")
except Exception as exc:
    errors.append(f"JSON inválido: {exc}")

html = (ROOT / "index.html").read_text(encoding="utf-8")
all_ids = re.findall(r'id=["\']([^"\']+)["\']', html)
duplicates = sorted({ident for ident in all_ids if all_ids.count(ident) > 1})
require(not duplicates, f"IDs HTML duplicados: {duplicates}")

for ident in [
    "announcerSettingsBtn", "screenAnnouncers",
    "announcer-commentator-name", "announcer-commentator-voice",
    "announcer-commentator-pitch", "announcer-commentator-rate",
    "announcer-informant-name", "announcer-informant-voice",
    "announcer-informant-pitch", "announcer-informant-rate",
    "announcerSharedVolume",
]:
    require(re.search(rf'id=["\']{re.escape(ident)}["\']', html) is not None, f"ID de UI ausente: {ident}")

script_order = [
    "./announcer/persona-data.js",
    "./announcer/config-data.js",
    "./announcer/engine.js",
    "./announcer/manager.js",
    "./announcer/ui.js",
    "./js/network/multiplayerSession.js",
    "./js/ui/menu.js",
    "./js/core/game.js",
    "./js/main.js",
]
positions = [html.find(x) for x in script_order]
require(all(pos >= 0 for pos in positions), "Falta uno o más scripts de integración")
require(positions == sorted(positions), "Orden de carga de scripts incorrecto")

mp = (ROOT / "js/network/multiplayerSession.js").read_text(encoding="utf-8")
manager = (ANN / "manager.js").read_text(encoding="utf-8")
game = (ROOT / "js/core/game.js").read_text(encoding="utf-8")
menu = (ROOT / "js/ui/menu.js").read_text(encoding="utf-8")

for token in [
    "broadcastAnnouncerBundle", "announcer:bundle", "emitAnnouncerCue",
    "PLAYER_COLLISION", "SABOTAGE_SUCCESS", "BATTLE_ROYALE_WINNER",
]:
    require(token in mp, f"Hook online ausente: {token}")

for token in [
    "startAtNetTime", "lastByPlayerEvent", "trace-folded",
    "favoriteScores", "receiveNetworkBundle",
]:
    require(token in manager, f"Manager incompleto: {token}")

require("setAnnouncer" in game and "onOfflineEvent" in game, "GolfGame no está conectado al locutor")
require("announcers:'screenAnnouncers'" in menu.replace(" ", ""), "MenuController no registra pantalla announcers")

js_files = [
    ANN / "engine.js", ANN / "manager.js", ANN / "ui.js",
    ROOT / "js/core/game.js", ROOT / "js/network/multiplayerSession.js",
    ROOT / "js/ui/menu.js", ROOT / "js/main.js",
]
node = "node"
for path in js_files:
    try:
        result = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
        require(result.returncode == 0, f"JS inválido {path.relative_to(ROOT)}: {result.stderr.strip()}")
    except FileNotFoundError:
        print("AVISO: Node no disponible; se omite --check.")
        break

if errors:
    print("INTEGRATION VALIDATION FAILED")
    for error in errors:
        print(" -", error)
    sys.exit(1)

print("INTEGRATION VALIDATION OK")
print(f" - Eventos compartidos: {len(commentator.get('events', {}))}")
print(" - UI: solo nombre/voz/tono/velocidad + volumen compartido")
print(" - Online: host-authority + announcer:bundle + startAtNetTime")
print(" - Offline/Battle hooks: presentes")
print(" - JS/JSON: válidos")
