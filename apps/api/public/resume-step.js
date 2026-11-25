"use strict";
// Setup step one: upload a resume, then check one pre-filled review and save.
// The file is read on this device by /vendor/resume-import.js (pdf.js, mammoth and unified-latex,
// loaded only when this step opens). Only the text the person approves is sent, when they save.
// Uses the helpers defined in app.js (el, btn, input, api, …); every value is set as text, never HTML.

let readerModule = null;
const loadReader = () => (readerModule ??= import("/vendor/resume-import.js").catch((e) => { readerModule = null; throw e; }));
const RESUME_ACCEPT = ".pdf,.docx,.tex,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/x-tex,text/x-tex";
const uid = () => `r${Math.random().toString(36).slice(2, 9)}`;

async function resumeStep(body, next, out) {
  const last = await api("GET", "/resume/import").catch(() => ({ last: null, importedFacts: 0 }));
  loadReader().catch(() => {}); // start fetching the reader while the person picks a file
  const fileInput = input({ type: "file", accept: RESUME_ACCEPT, class: "vh", id: "resume-file" });
  const drop = el("label", { class: "drop", for: "resume-file" },
    el("span", { class: "drop-icon", "aria-hidden": "true" }, icon("doc")),
    el("span", { class: "drop-text" }, el("strong", {}, "Drop your resume here"),
      el("span", { class: "note" }, "or choose a file · PDF, Word (.docx) or LaTeX (.tex), up to 10 MB")),
    el("span", { class: "btn primary" }, icon("up"), "Choose a file"));
  const status = el("div", { "aria-live": "polite" });
  const paste = el("textarea", { rows: 10, placeholder: "Paste the text of your resume", "aria-label": "Resume text" });
  const readPaste = btn("Read this text");
  const go = async (getResume, name, format) => {
    clear(status, el("div", { class: "reading" }, el("span", { class: "spinner", "aria-hidden": "true" }), `Reading ${name} on this device…`));
    try {
      const mod = await loadReader();
      const parsed = await getResume(mod);
      reviewResume(body, next, out, parsed, { name, format: format || parsed.source, mod, last });
    } catch (e) {
      const known = e && e.name === "ImportError";
      clear(status, msg("stop", known ? e.message : "That file couldn't be read. Try the PDF or Word version, or paste the text below."));
      if (!known) console.error(e);
    }
  };
  fileInput.addEventListener("change", () => { const f = fileInput.files && fileInput.files[0]; if (f) go((m) => m.readResumeFile(f), f.name); });
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) go((m) => m.readResumeFile(f), f.name); });
  readPaste.addEventListener("click", () => { if (paste.value.trim()) go((m) => m.readResumeText(paste.value), "the pasted text", "text"); });
  clear(body,
    last.last ? msg("info", `You imported ${last.last.file_name || "a resume"} on ${fmtDay(last.last.created_at)}. A new import can replace those ${plural(last.importedFacts, "fact")}; anything you added by hand stays.`) : null,
    el("div", { class: "sheet" }, fileInput, drop, status,
      el("p", { class: "note measure", style: { margin: "12px 0 0" } }, "The file is read in your browser and never uploaded. Only what you approve on the next screen is saved.")),
    el("details", { class: "paste" }, el("summary", {}, "No file to hand? Paste the text instead"),
      el("div", { class: "stack", style: { marginTop: "12px" } }, paste, el("div", { class: "row" }, readPaste))),
    last.importedFacts ? wizardFoot(el("button", { class: "btn", type: "button", onclick: () => next() }, "Keep what I have", icon("arrow"))) : null);
}

/** "2021-03" → "Mar 2021"; "2021" stays "2021". */
const fmtPartial = (d) => (!d ? "" : d.length === 4 ? d : new Date(`${d}-15T12:00:00Z`).toLocaleDateString("en", { month: "short", year: "numeric", timeZone: "UTC" }));
const checkTag = () => el("span", { class: "tag hold check-tag" }, "Check");

function reviewResume(body, next, out, r, ctx) {
  const { mod } = ctx;
  // A text field bound to one property; marked "Check" when the reader had to guess it.
  const bind = (obj, key, labelText, opts = {}) => {
    const control = input({ value: obj[key] || "", autocomplete: opts.autocomplete || "off", inputmode: opts.inputmode || null, id: uid() });
    if (opts.guess) control.classList.add("guess");
    const lab = el("label", { for: control.id }, labelText, opts.guess ? checkTag() : null);
    control.addEventListener("input", () => { obj[key] = control.value; control.classList.remove("guess"); lab.querySelector(".check-tag")?.remove(); });
    return el("div", { class: "fld" }, lab, control);
  };
  // Dates shown as "Mar 2021" and read back with the same parser the import used.
  const dateField = (obj, key, labelText, guess) => {
    const control = input({ value: fmtPartial(obj[key]), placeholder: "Mar 2021", autocomplete: "off", id: uid() });
    if (guess) control.classList.add("guess");
    const lab = el("label", { for: control.id }, labelText, guess ? checkTag() : null);
    const err = el("span", { class: "fld-err", "aria-live": "polite" });
    control.addEventListener("input", () => {
      const v = control.value.trim();
      const d = v ? mod.parseDate(v) : null;
      control.classList.remove("guess");
      lab.querySelector(".check-tag")?.remove();
      const bad = !!v && !d;
      control.setAttribute("aria-invalid", bad ? "true" : "false");
      err.textContent = bad ? "Write it like Mar 2021 or 2021" : "";
      obj[key] = d;
    });
    return el("div", { class: "fld date" }, lab, control, err);
  };
  const linesEditor = (list, placeholder) => {
    const box = el("ul", { class: "lines" });
    const add = (i) => {
      const t = el("textarea", { rows: 1, value: list[i], "aria-label": "Achievement", placeholder });
      t.addEventListener("input", () => { list[i] = t.value; });
      const li = el("li", {}, t);
      li.append(el("button", { type: "button", class: "icon-btn", "aria-label": "Remove this line", onclick: () => { list[i] = ""; li.remove(); } }, icon("x")));
      box.append(li);
      return t;
    };
    list.forEach((_, i) => add(i));
    return el("div", {}, box, el("button", { type: "button", class: "btn quiet small", onclick: () => { list.push(""); add(list.length - 1).focus(); } }, icon("plus"), "Add a line"));
  };
  const entryBlock = (list, i, kind) => {
    const e = list[i];
    const u = e.unsure || [];
    const node = el("div", { class: "entry" });
    const remove = el("button", { type: "button", class: "btn quiet small danger", onclick: () => { list[i] = null; node.remove(); } }, icon("x"), "Remove");
    if (kind === "role") {
      const cur = input({ type: "checkbox", checked: e.current });
      const endFld = dateField(e, "end", "To", u.includes("dates") && !e.current);
      const endInput = endFld.querySelector("input");
      const setNow = (now) => { endInput.disabled = now; endInput.placeholder = now ? "Present" : "Mar 2021"; };
      setNow(!!e.current);
      cur.addEventListener("change", () => { e.current = cur.checked; setNow(cur.checked); if (cur.checked) { e.end = null; endInput.value = ""; endInput.setAttribute("aria-invalid", "false"); } });
      append(node, [
        el("div", { class: "entry-grid" },
          bind(e, "title", "Title", { guess: u.includes("title") }), bind(e, "org", "Company", { guess: u.includes("org") }), bind(e, "location", "Place"),
          dateField(e, "start", "From", u.includes("dates")), endFld, el("label", { class: "check now" }, cur, el("span", {}, "I work here now"))),
        linesEditor(e.bullets, "What you did, with a number if you have one"),
        el("div", { class: "entry-foot" }, remove)]);
    } else if (kind === "education") {
      append(node, [el("div", { class: "entry-grid" },
        bind(e, "degree", "Degree", { guess: u.includes("degree") }), bind(e, "org", "School", { guess: u.includes("org") }), bind(e, "location", "Place"),
        dateField(e, "start", "From"), dateField(e, "end", "To")), el("div", { class: "entry-foot" }, remove)]);
    } else {
      const tech = input({ value: (e.tech || []).join(", "), id: uid() });
      tech.addEventListener("input", () => { e.tech = tech.value.split(",").map((x) => x.trim()).filter(Boolean); });
      append(node, [el("div", { class: "entry-grid" }, bind(e, "name", "Project"), el("div", { class: "fld" }, el("label", { for: tech.id }, "Built with"), tech), dateField(e, "date", "When")),
        linesEditor(e.bullets, "What it does or what you did"), el("div", { class: "entry-foot" }, remove)]);
    }
    return node;
  };
  const entries = (list, kind, empty) => {
    const box = el("div", { class: "entries" }, list.map((_, i) => entryBlock(list, i, kind)));
    if (!list.length) box.append(el("p", { class: "note empty-note" }, empty));
    return box;
  };
  const addEntry = (list, kind, blank, box, label) => el("button", { type: "button", class: "btn small", onclick: () => {
    list.push(blank()); box.querySelector(".empty-note")?.remove();
    box.append(entryBlock(list, list.length - 1, kind)); box.lastChild.querySelector("input").focus();
  } }, icon("plus"), label);
  const section = (title, note, content, addBtn, id) =>
    el("section", { class: "sheet review", "aria-labelledby": id }, el("div", { class: "sheet-head" }, el("h2", { id }, title), el("span", { class: "note" }, note)), content, addBtn ? el("div", { class: "row", style: { marginTop: "12px" } }, addBtn) : null);

  // Skills as removable chips plus an add field.
  const skillBox = el("div", { class: "skill-chips" });
  const drawSkills = () => clear(skillBox, r.skills.map((sk, i) => el("span", { class: "skill" }, sk,
    el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${sk}`, onclick: () => { r.skills.splice(i, 1); drawSkills(); } }, icon("x")))));
  drawSkills();
  const skillIn = input({ placeholder: "Add a skill, then press Enter", "aria-label": "Add a skill" });
  skillIn.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault();
    for (const v of skillIn.value.split(",").map((x) => x.trim()).filter(Boolean)) if (!r.skills.some((x) => x.toLowerCase() === v.toLowerCase())) r.skills.push(v);
    skillIn.value = ""; drawSkills();
  });

  const LEVELS = [["A1", "A1 beginner"], ["A2", "A2"], ["B1", "B1 intermediate"], ["B2", "B2"], ["C1", "C1 advanced"], ["C2", "C2 proficient"], ["native", "Native"]];
  const langBox = el("ul", { class: "list" });
  const drawLang = (l) => {
    const name = input({ value: l.language, "aria-label": "Language" });
    name.addEventListener("input", () => { l.language = name.value.trim(); });
    const lvl = select(LEVELS, l.level, { "aria-label": `Level in ${l.language || "this language"}` });
    lvl.addEventListener("change", () => { l.level = lvl.value; });
    const li = el("li", {}, el("div", { class: "grow", style: { maxWidth: "260px" } }, name), el("div", { style: { width: "180px" } }, lvl));
    li.append(el("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${l.language || "language"}`, onclick: () => { l.language = ""; li.remove(); } }, icon("x")));
    langBox.append(li);
  };
  r.languages.forEach(drawLang);

  const certBox = el("ul", { class: "list" });
  for (const cert of r.certifications) {
    const li = el("li", {}, el("div", { class: "grow" }, bind(cert, "name", "Certification")), el("div", { style: { width: "140px" } }, dateField(cert, "date", "Year")));
    li.append(el("button", { type: "button", class: "icon-btn", "aria-label": "Remove certification", onclick: () => { cert.name = ""; li.remove(); } }, icon("x")));
    certBox.append(li);
  }

  // Sections the reader couldn't place: shown, saved only when ticked.
  const extraPick = [];
  const others = r.other.filter((o) => o.lines.length).map((o) => el("div", { class: "other" },
    el("h3", {}, o.heading),
    el("ul", { class: "list" }, o.lines.map((line) => {
      const cb = input({ type: "checkbox" });
      extraPick.push({ cb, line });
      return el("li", {}, el("label", { class: "check" }, cb, el("span", {}, line)));
    }))));

  const c = r.contact;
  const achievements = r.experience.reduce((n, e) => n + e.bullets.length, 0);
  const found = [plural(r.experience.length, "role"), plural(achievements, "achievement"), plural(r.education.length, "degree"), plural(r.skills.length, "skill"), plural(r.languages.length, "language")];
  const guesses = [...r.experience, ...r.education].reduce((n, e) => n + (e.unsure || []).length, 0);
  const roleBox = entries(r.experience, "role", "No roles were found. Add them here.");
  const eduBox = entries(r.education, "education", "No education was found.");
  const projBox = entries(r.projects, "project", "");
  const save = btn("Save and continue", { kind: "primary", icon: "arrow" });
  const replaceBox = ctx.last && ctx.last.importedFacts ? input({ type: "checkbox", checked: true }) : null;
  const footOut = el("div", { "aria-live": "polite" });
  action(save, footOut, async () => {
    const bad = body.ownerDocument.querySelectorAll('.review-page [aria-invalid="true"]');
    if (bad.length) { bad[0].focus(); throw new Error("A date couldn't be read. Write it like Mar 2021, or just the year."); }
    const clean = (xs) => xs.map((x) => (x || "").trim()).filter(Boolean);
    const payload = {
      format: ctx.format, fileName: ctx.name, replace: !!(replaceBox && replaceBox.checked), contact: c, summary: r.summary,
      experience: r.experience.filter(Boolean).map((e) => ({ ...e, bullets: clean(e.bullets) })).filter((e) => (e.title || "").trim() || (e.org || "").trim()),
      education: r.education.filter(Boolean).filter((e) => (e.degree || "").trim() || (e.org || "").trim()),
      projects: r.projects.filter(Boolean).map((p) => ({ ...p, bullets: clean(p.bullets) })).filter((p) => (p.name || "").trim()),
      skills: r.skills, certifications: r.certifications.filter((x) => (x.name || "").trim()),
      languages: r.languages.filter((l) => l.language), extra: extraPick.filter((x) => x.cb.checked).map((x) => x.line),
    };
    const res = await api("POST", "/resume/import", payload);
    state.suggestedTitle = res.suggestions.targetTitle;
    toast(`Saved ${plural(res.facts, "fact")}`);
    await next();
  });

  render(el("div", { class: "wizard review-page" },
    $main.querySelector(".stepper"),
    pageHead("Check what we found", `${found.join(", ")} in ${ctx.name}.${guesses ? " Fields marked Check were guesses." : ""} Fix anything that's off, then save.`),
    r.warnings.length ? msg("hold", el("ul", {}, r.warnings.map((w) => el("li", {}, w)))) : null,
    out,
    section("About you", "Goes into your answer bank, so forms get it exactly", el("div", { class: "entry-grid" },
      bind(c, "name", "Full name", { autocomplete: "name" }), bind(c, "email", "Email", { autocomplete: "email", inputmode: "email" }), bind(c, "phone", "Phone", { autocomplete: "tel", inputmode: "tel" }),
      bind(c, "location", "Where you live"), bind(c, "linkedin", "LinkedIn"), bind(c, "website", "Website"), bind(c, "github", "GitHub")), null, "rv-about"),
    section("Experience", plural(r.experience.length, "role"), roleBox,
      addEntry(r.experience, "role", () => ({ title: "", org: "", location: "", start: null, end: null, current: false, bullets: [""], unsure: [] }), roleBox, "Add a role"), "rv-exp"),
    section("Education", plural(r.education.length, "entry", "entries"), eduBox,
      addEntry(r.education, "education", () => ({ degree: "", org: "", location: "", start: null, end: null, details: [], unsure: [] }), eduBox, "Add education"), "rv-edu"),
    r.projects.length ? section("Projects", plural(r.projects.length, "project"), projBox,
      addEntry(r.projects, "project", () => ({ name: "", tech: [], date: null, bullets: [""] }), projBox, "Add a project"), "rv-proj") : null,
    section("Skills", plural(r.skills.length, "skill"), el("div", {}, skillBox, el("div", { style: { maxWidth: "340px", marginTop: "12px" } }, skillIn)), null, "rv-skills"),
    r.certifications.length ? section("Certifications", plural(r.certifications.length, "certification"), certBox, null, "rv-cert") : null,
    section("Languages", plural(r.languages.length, "language"), langBox,
      el("button", { type: "button", class: "btn small", onclick: () => { const l = { language: "", level: "C1" }; r.languages.push(l); drawLang(l); langBox.lastChild.querySelector("input").focus(); } }, icon("plus"), "Add a language"), "rv-lang"),
    others.length ? section("Also in your resume", "Saved only if you tick them", el("div", {}, others), null, "rv-other") : null,
    footOut,
    el("div", { class: "review-foot" },
      el("div", { class: "grow" }, el("strong", {}, "Everything here is saved as true."), el("span", { class: "note" }, " It's used in scores, resumes and answers, so fix anything that isn't."),
        replaceBox ? el("label", { class: "check", style: { marginTop: "6px" } }, replaceBox, el("span", {}, `Replace the ${plural(ctx.last.importedFacts, "fact")} from my last import`)) : null),
      el("button", { type: "button", class: "btn quiet", onclick: () => VIEWS.setup("facts") }, "Use another file"), save)));
  window.scrollTo(0, 0);
}
