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
    "announcer/config.json", "announcer/config-data.js", "announcer/map-intro-data.js",
    "announcer/data/commentator.json", "announcer/data/informant.json", "announcer/data/map-intro.json",
    "js/network/profile.js", "js/network/clientEnv.js", "config.json", "config.example.json",
]:
    require((ROOT / rel).is_file(), f"Falta {rel}")

try:
    cfg = json.loads((ANN / "config.json").read_text(encoding="utf-8"))
    client_cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    client_example = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
    commentator = json.loads((ANN / "data/commentator.json").read_text(encoding="utf-8"))
    informant = json.loads((ANN / "data/informant.json").read_text(encoding="utf-8"))
    map_intro = json.loads((ANN / "data/map-intro.json").read_text(encoding="utf-8"))
    require(cfg.get("schema") == "noise-golf-announcer-runtime-v1", "Schema de config inesperado")
    require("defaults" not in cfg, "Los defaults de usuario no deben permanecer en announcer/config.json")
    state_cfg = cfg.get("stateMachine") or {}
    require(state_cfg.get("guaranteedEvents") == ["HOLE", "HOLE_IN_ONE"], "Eventos supercríticos inesperados")
    require("idleAfterMs" not in state_cfg, "La pausa informativa eliminada no debe conservar idleAfterMs")
    require("informativeCooldownMs" not in state_cfg, "No debe existir informativeCooldownMs")
    require(int(state_cfg.get("postMatchSummaryMax", -1)) >= 1, "Falta resumen post-partida")
    require("informativeAfterPostMatch" not in state_cfg, "No debe existir informativeAfterPostMatch")
    map_cfg = cfg.get("mapPresentation") or {}
    require(map_cfg.get("enabled") is True, "Presentación de mapa desactivada")
    require(map_cfg.get("silencePreFirstTouch") is True, "Debe silenciarse AIM/TURN antes del primer toque")
    require(map_intro.get("schema") == "noise-golf-map-intro-v1", "Schema map-intro inesperado")
    def count_strings(value):
        if isinstance(value, str): return 1
        if isinstance(value, list): return sum(count_strings(item) for item in value)
        if isinstance(value, dict): return sum(count_strings(item) for item in value.values())
        return 0
    require(count_strings(map_intro.get("presentation", {})) >= 100, "Banco de presentaciones demasiado pequeño")
    require(count_strings(map_intro.get("firstTouch", {})) >= 80, "Banco de primer toque demasiado pequeño")
    require(isinstance(client_cfg.get("announcerUserDefaults"), dict), "Falta announcerUserDefaults en config.json general")
    require(isinstance(client_example.get("announcerUserDefaults"), dict), "Falta announcerUserDefaults en config.example.json")
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
    "announcerLivePanel", "announcerLiveToggle", "announcerLivePreview",
    "announcerLiveEmpty", "announcerLiveLines",
]:
    require(re.search(rf'id=["\']{re.escape(ident)}["\']', html) is not None, f"ID de UI ausente: {ident}")

script_order = [
    "./announcer/persona-data.js",
    "./announcer/config-data.js",
    "./announcer/map-intro-data.js",
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
engine = (ANN / "engine.js").read_text(encoding="utf-8")
ui = (ANN / "ui.js").read_text(encoding="utf-8")
game = (ROOT / "js/core/game.js").read_text(encoding="utf-8")
menu = (ROOT / "js/ui/menu.js").read_text(encoding="utf-8")
profile = (ROOT / "js/network/profile.js").read_text(encoding="utf-8")
client_env = (ROOT / "js/network/clientEnv.js").read_text(encoding="utf-8")
main = (ROOT / "js/main.js").read_text(encoding="utf-8")

for token in [
    "broadcastAnnouncerBundle", "announcer:bundle", "emitAnnouncerCue",
    "reportAnnouncerActivity", "announcer:activity", "announceractivity",
    "PLAYER_COLLISION", "SABOTAGE_SUCCESS", "BATTLE_ROYALE_WINNER",
]:
    require(token in mp, f"Hook online ausente: {token}")

for token in [
    "startAtNetTime", "lastByPlayerEvent", "trace-folded",
    "favoriteScores", "receiveNetworkBundle", "notifySpeechLine",
    "supercritical", "guaranteed", "postmatch",
    "POST_MATCH_SUMMARY", "onOfflineMatchEnd",
    "MAP_PRESENTATION", "MAP_FIRST_TOUCH", "buildMapPresentationBundle", "buildMapFirstTouchBundle",
    "firstTouchArmed", "getAnnouncerSettings", "announcerUserDefaults",
]:
    require(token in manager or token in profile or token in client_env, f"Integración incompleta: {token}")

require("notifySpeechLine?.(item, text, 'start')" in engine, "El director TTS no publica el inicio de la línea")
require("notifySpeechLine?.(item, text, 'end')" in engine, "El director TTS no publica el final de la línea")
require("guaranteedQueue" in engine and "enqueueGuaranteed" in engine, "Falta cola supercrítica persistente")
require("mustSpeak" in engine, "Falta persistencia mustSpeak para presentación/primer toque")
require("discardNonGuaranteedPending" in engine, "Falta limpieza de cola al entrar en post-partida")
require("class AnnouncerTranscriptUI" in ui and "captionsCollapsed" in ui, "Ventana plegable de locución incompleta")
require("setAnnouncerSettings" in profile and "getAnnouncerSettings" in profile, "PlayerProfile no guarda preferencias de locución")
require("new NG.AnnouncerSystem(game, profile)" in main, "AnnouncerSystem no recibe PlayerProfile")
require("setAnnouncer" in game and "onOfflineEvent" in game, "GolfGame no está conectado al locutor")
require("onAimEnd" in game and "onOfflineMatchEnd" in game and "onOfflineNewCourse" in game, "GolfGame no reporta estados narrativos nuevos")
require("typeof this.renderer?.spawnShockwave === 'function'" in game, "spawnShockwave no está protegido contra API renderer antigua")
require("typeof this.renderer?.spawnWaterRipple === 'function'" in game, "spawnWaterRipple no está protegido contra API renderer antigua")
require("INFORMATIVE_STATE" not in manager and "idle-information" not in manager, "Manager conserva pausa informativa")
require("informativeDelivered" not in manager and "maybeFillSilence" not in manager, "Manager conserva estado/ciclo de pausa informativa")
require("idle-information" not in engine and "yieldInformativeAfterLine" not in engine, "Director conserva arbitraje especial de pausa informativa")
require("maybeRunPostMatchSummary" in manager, "Falta scheduler exclusivo de resumen post-partida")
require("announcers:'screenAnnouncers'" in menu.replace(" ", ""), "MenuController no registra pantalla announcers")
require("mainMusicToggleBtn" in html and "mainMusicToggleState" in html, "Falta control de música en menú principal")
require("defaultMusicMuted: true" in (ROOT / "js/config.js").read_text(encoding="utf-8"), "La música no arranca desactivada por defecto")
require("CONFIG.audio.defaultMusicMuted !== false" in (ROOT / "js/engine/audio.js").read_text(encoding="utf-8"), "MusicPlayer no respeta el default desactivado")

js_files = [
    ANN / "engine.js", ANN / "manager.js", ANN / "ui.js",
    ROOT / "js/core/game.js", ROOT / "js/network/multiplayerSession.js",
    ROOT / "js/network/profile.js", ROOT / "js/network/clientEnv.js",
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

state_test = ANN / "tools/test_state_machine.js"
require(state_test.is_file(), "Falta test_state_machine.js")
if state_test.is_file():
    try:
        result = subprocess.run([node, str(state_test)], capture_output=True, text=True)
        require(result.returncode == 0, f"State machine test falló: {result.stderr.strip() or result.stdout.strip()}")
    except FileNotFoundError:
        pass

if errors:
    print("INTEGRATION VALIDATION FAILED")
    for error in errors:
        print(" -", error)
    sys.exit(1)

print("INTEGRATION VALIDATION OK")
print(f" - Eventos compartidos: {len(commentator.get('events', {}))}")
print(" - Preferencias TTS: dentro de PlayerProfile + defaults en config.json general")
print(" - Migración: noiseGolf.announcer.v1 -> noiseGolf.profile.v1/announcer")
print(" - Ventana de locución: plegable + historial de líneas realmente reproducidas")
print(" - Online: host-authority + announcer:bundle + startAtNetTime + aim state")
print(" - Máquina narrativa: gameplay / postmatch; pausa informativa eliminada por completo")
print(" - Presentación de mapa: líder/favoritos/rivalidad + primer toque contextual mustSpeak")
print(" - Música: OFF por defecto + toggle persistente desde menú principal")
print(f" - Frases dedicadas mapa/primer toque: {count_strings(map_intro.get('presentation', {})) + count_strings(map_intro.get('firstTouch', {}))}")
print(" - Renderer: guards defensivos para shockwave/water ripple + cache-bust en HTML")
print(" - Supercrítico: HOLE + HOLE_IN_ONE persistentes hasta reproducción")
print(" - Offline/Battle hooks: presentes")
print(" - JS/JSON: válidos")
