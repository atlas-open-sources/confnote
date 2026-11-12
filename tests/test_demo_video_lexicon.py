"""The demo-video TTS lexicon: every entry becomes inline SSML, whole words only, in one pass."""

import importlib.util
import json
from pathlib import Path

VOICE_DIR = Path(__file__).resolve().parents[1] / "tools" / "demo-video" / "voice"


def load_tts():
    spec = importlib.util.spec_from_file_location("demo_video_tts", VOICE_DIR / "tts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tts = load_tts()


def body(text: str) -> str:
    ssml = tts.ssml_for(text, "+0%")
    return ssml.split('<prosody rate="+0%">', 1)[1].split("</prosody>", 1)[0]


def test_every_entry_is_spoken_through_markup():
    entries = json.loads((VOICE_DIR / "lexicon.json").read_text())["entries"]
    for entry in entries:
        spoken = body(f"I tried {entry['text']} today.")
        assert spoken != f"I tried {entry['text']} today.", entry["text"]
        assert f">{entry['text']}</" in spoken


def test_names_get_their_checked_pronunciation():
    assert body("Bryntum") == '<sub alias="Brin-tum">Bryntum</sub>'
    assert body("tldraw") == '<phoneme alphabet="ipa" ph="ˌtiːˈɛlˌdrɔː">tldraw</phoneme>'
    assert body("BYOK") == '<say-as interpret-as="characters">BYOK</say-as>'
    assert body("DevDay") == '<sub alias="Dev Day">DevDay</sub>'


def test_whole_words_only_and_no_double_wrapping():
    assert body("Bryntums and AG Gridlock") == "Bryntums and AG Gridlock"
    spoken = body("Mochi Router made it with ACE-Step 1.5.")
    assert spoken.count("<phoneme") == 1
    assert '<sub alias="Ace, Step">ACE-Step</sub>' in spoken
    assert '<phoneme alphabet="ipa" ph="ˈmoʊtʃi">Mochi</phoneme> Router' in spoken


def test_possessive_is_spoken_inside_the_markup():
    assert body("Bryntum's") == "<sub alias=\"Brin-tum's\">Bryntum's</sub>"
    assert body("confnote's") == "<sub alias=\"conf note's\">confnote's</sub>"
    assert body("DevDay's") == "<sub alias=\"Dev Day's\">DevDay's</sub>"


def test_text_is_xml_escaped_around_markup():
    assert body("AG Grid & tldraw").startswith("AG Grid &amp; <phoneme")


def test_ssml_speaks_in_the_voice_locale():
    assert 'xml:lang="en-GB"' in tts.ssml_for("Hello.", "+0%", "en-GB-RyanNeural")
    assert 'xml:lang="en-US"' in tts.ssml_for("Hello.", "+0%", "en-US-AndrewMultilingualNeural")
