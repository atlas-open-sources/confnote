/* Optional day goals, stored in the conference's canonical BRIEF.md. The conference sidebar's
   "Day goals" button (app.js, beside Brief / Actions / Debrief) opens it for that conference. */
(() => {
  let opening = false;

  async function conferenceFor(slug) {
    const response = await fetch("/api/conferences");
    if (!response.ok) throw new Error("Could not read your conferences.");
    return (await response.json()).find((conference) => conference.slug === slug) || null;
  }

  async function open(slug) {
    if (opening || document.querySelector(".modal-ov")) return;
    opening = true;
    let conference;
    let initial;
    try {
      conference = await conferenceFor(slug);
      if (!conference) throw new Error("This conference is no longer in your notes.");
      const response = await fetch("/api/conf-doc?slug=" + encodeURIComponent(conference.slug));
      if (!response.ok) throw new Error("Could not read your conference brief.");
      initial = await response.json();
    } catch (error) {
      opening = false;
      if (window.confnoteToast) window.confnoteToast(error.message);
      return;
    }
    opening = false;
    const previousFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "modal-ov day-setup";
    overlay.innerHTML =
      '<section class="modal-box" role="dialog" aria-modal="true" aria-labelledby="daySetupTitle">' +
      '<h2 id="daySetupTitle">What would make today worthwhile?</h2>' +
      '<p class="day-setup-intro"></p>' +
      '<form><label>What are you building or working on?<textarea name="goals" rows="2" maxlength="2000" placeholder="A project, a problem, or something you want to learn"></textarea></label>' +
      '<label>Which topics or people interest you?<textarea name="interests" rows="2" maxlength="2000" placeholder="Coding agents, voice, design, meeting other builders…"></textarea></label>' +
      '<label>What do you want to leave with?<textarea name="outcome" rows="2" maxlength="2000" placeholder="A working prototype, one useful connection, a clear next step"></textarea></label>' +
      '<p class="day-setup-error" role="alert"></p><div class="day-setup-actions"><button type="button" class="day-setup-skip">Maybe later</button><button type="submit">Save my day goals</button></div></form></section>';
    overlay.querySelector(".day-setup-intro").textContent =
      conference.name +
      ". Your answers stay in your local notes. Saving does not start an AI request.";
    const form = overlay.querySelector("form");
    const error = overlay.querySelector(".day-setup-error");
    function close() {
      overlay.remove();
      document.removeEventListener("keydown", keydown);
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    }
    function keydown(event) {
      if (event.key === "Escape") close();
      if (event.key !== "Tab") return;
      const controls = [...overlay.querySelectorAll("textarea, button")];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    form.onsubmit = async (event) => {
      event.preventDefault();
      const fields = ["goals", "interests", "outcome"].map((name) =>
        form.elements[name].value.trim(),
      );
      if (!fields.some(Boolean)) {
        error.textContent = "Add at least one answer, or choose Maybe later.";
        return;
      }
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      const lines = [
        "## My day goals",
        "",
        "### What I'm working on",
        "",
        fields[0] || "Still exploring.",
        "",
        "### Topics and people",
        "",
        fields[1] || "Open to suggestions.",
        "",
        "### A worthwhile outcome",
        "",
        fields[2] || "Find a useful next step.",
        "",
      ];
      const text = (initial.brief ? initial.brief.trimEnd() + "\n\n" : "") + lines.join("\n");
      try {
        const response = await fetch(
          "/api/conf-doc?slug=" + encodeURIComponent(conference.slug) + "&name=BRIEF.md",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, mtime: initial.brief_mtime || 0 }),
          },
        );
        if (!response.ok)
          throw new Error(
            response.status === 409
              ? "Your brief changed elsewhere. Close and reopen this form to keep both edits."
              : "Could not save your goals. Please try again.",
          );
        close();
        location.hash = "#/" + conference.slug + "/~brief";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      } catch (failure) {
        error.textContent = failure.message;
        submit.disabled = false;
      }
    };
    overlay.querySelector(".day-setup-skip").onclick = close;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener("keydown", keydown);
    document.body.append(overlay);
    form.elements.goals.focus();
  }

  window.confnote = window.confnote || {};
  window.confnote.openDayGoals = open;
})();
