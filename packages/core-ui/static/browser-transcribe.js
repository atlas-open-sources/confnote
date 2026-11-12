/* browser-transcribe.js — the hosted site's Transcript lock.
 *
 * musa, 2026-11-11: conferences may not like recording and transcription, so on
 * the hosted site the Transcript tab stays visible but locked. Nothing records
 * or transcribes there: no microphone, no audio file, no OpenAI key path. The
 * tab explains, behind an info button, that transcription runs on device in
 * the confnote Mac app with Local AI Cat, so audio stays on the Mac, and asks
 * people to mind each conference's recording rules. A transcript can still be
 * pasted in by hand; app.js saves it into the note's `## Transcript` through
 * the note API.
 *
 * Earlier steps, for the record: the hosted page first called Local AI Cat from
 * the browser (dropped 2026-11-11, the Cat would have had to open its local AI
 * server to a website), then transcribed with the tab's own OpenAI key
 * (dropped the same day by this lock). See
 * docs/integration/local-ai-cat-transcription.md.
 *
 * The Mac app is unchanged: its server records and transcribes with Local AI
 * Cat or OpenAI. The hosted server still answers `browser: true` from
 * /api/transcription/status and /api/settings, and never takes audio; app.js
 * and settings.js show the lock on the hosted page whatever those answer.
 */
(() => {
  const LOCAL_AI_CAT_URL = "https://localaicat.com";
  const LOCKED = "Transcription is locked on the web. You can paste a transcript you already have.";
  // The info popover, as three sentences; the link goes after "Local AI Cat".
  const INFO_ON_DEVICE = "Transcription runs on device in the confnote Mac app with Local AI Cat";
  const INFO_AUDIO = ", so audio stays on your Mac.";
  const INFO_WEB = "On the web it isn't available yet.";
  const INFO_RULES = "Please be mindful of each conference's recording rules.";

  // The popover body: plain text plus one link, built as nodes (no HTML strings).
  function infoNodes() {
    const link = document.createElement("a");
    link.href = LOCAL_AI_CAT_URL;
    link.textContent = "localaicat.com";
    link.target = "_blank";
    link.rel = "noopener";
    const first = document.createElement("p");
    first.append(`${INFO_ON_DEVICE} (`, link, `)${INFO_AUDIO}`);
    const second = document.createElement("p");
    second.textContent = INFO_WEB;
    const third = document.createElement("p");
    third.textContent = INFO_RULES;
    return [first, second, third];
  }

  window.confnote = window.confnote || {};
  window.confnote.browserTranscription = {
    LOCAL_AI_CAT_URL,
    LOCKED,
    INFO_ON_DEVICE,
    INFO_WEB,
    INFO_RULES,
    infoNodes,
  };
})();
