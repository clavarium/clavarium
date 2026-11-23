/* One shared snippet: the site map. It is the home's main visual ([data-map])
   and the menu on every page (the "Menu" button opens it in a dialog).
   Green = feature, orange = use case. "#soon" = page not built yet. */
(function () {
  var F = [
    ['One machine each', 'isolated-agents.html', 'One VM per agent, or several in one.', 'agents stay apart', 'agents stay apart'],
    ['Choose what each sees', 'assets-and-keys.html', 'Keys, folders, accounts: given per agent, taken back.', 'accounts and folders', 'accounts and folders'],
    ['Work from your phone', 'parley.html', 'Chat with your agents from your phone or computer.', 'or computer', 'or computer'],
    ['Connect what you use', 'tether.html', 'Mail, contacts, calendar, files, browser, MCP.', 'mail, calendar, files, more', 'mail, calendar, files, more'],
    ['Speak, it answers', 'voice-boxes.html', 'Talk to your AI from any room.', 'with a voice box', 'with a voice box'],
    ['One room, several AIs', 'rooms.html', 'Several AIs in one room, hand-overs capped.', 'they work together', 'they work together']
  ];
  var U = [
    ['Help the whole family', 'family.html', 'Marcel, 82, talks to a box at home.'],
    ['Fix bugs, review code', 'coding-agents.html', 'Several agents in parallel, you review.'],
    ['Use AI hosted in Europe', 'data-sovereignty.html', 'Your server, a European AI provider.'],
    ['Ask aloud at home', 'home-and-voice.html', 'A voice assistant that runs at home.'],
    ['Sort mail, plan meetings', 'mail-and-calendar.html', 'It drafts; you approve what goes out.'],
    ['Separate work, home, club', 'work-home-club.html', 'One assistant per life, nothing crosses over.']
  ];
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function col(kind, label, items) {
    var c = el('nav', 'col ' + kind);
    c.setAttribute('aria-label', label);
    c.appendChild(el('p', 'lbl', label));
    items.forEach(function (it) {
      var a = el('a');
      a.href = it[1];
      a.title = it[2];
      var t = el('span', 'nm', it[0]);
      if (it[3]) t.appendChild(el('small', 'cmp', it[3]));
      if (it[4]) t.appendChild(el('small', 'cs', ' · ' + it[4]));
      a.appendChild(t);
      a.appendChild(el('span', 'go', '↗'));
      a.appendChild(el('span', 'tip', it[2]));
      c.appendChild(a);
    });
    return c;
  }
  function map() {
    var m = el('div', 'map');
    m.appendChild(col('f', 'Features', F));
    var hub = el('div', 'hub');
    var srv = el('div', 'srv');
    srv.appendChild(el('b', '', 'Your server'));
    var ag = el('div', 'agents');
    ['Claude Code', 'Codex', 'Mistral Vibe', 'Gemini CLI', 'OpenCode'].forEach(function (n) { ag.appendChild(el('span', '', n)); });
    srv.appendChild(ag);
    hub.appendChild(srv);
    m.appendChild(hub);
    m.appendChild(col('u', 'Use cases', U));
    var foot = el('nav', 'foot');
    foot.setAttribute('aria-label', 'Start here');
    [['FAQ', 'faq.html'], ['Security', 'security.html']].forEach(function (l) { var a = el('a', '', l[0]); a.href = l[1]; foot.appendChild(a); });
    m.appendChild(foot);
    return m;
  }
  document.querySelectorAll('[data-map]').forEach(function (h) { h.appendChild(map()); });

  /* the menu: the same map, plus the secondary pages */
  var dlg = el('dialog', 'mapdlg');
  dlg.setAttribute('aria-label', 'Site map');
  var bar = el('div', 'bar');
  bar.appendChild(el('b', '', 'Site map'));
  var x = el('button', 'x', '×');
  x.setAttribute('aria-label', 'Close');
  x.onclick = function () { dlg.close(); };
  bar.appendChild(x);
  dlg.appendChild(bar);
  dlg.appendChild(map());
  var row = el('nav', 'maprow');
  [['Home', 'index.html'], ['Install', 'install.html'], ['Roadmap', 'roadmap.html'], ['GitHub', 'https://github.com/clavarium/clavarium']]
    .forEach(function (l) { var a = el('a', '', l[0]); a.href = l[1]; row.appendChild(a); });
  dlg.appendChild(row);
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  document.body.appendChild(dlg);
  document.querySelectorAll('[data-open-map]').forEach(function (b) {
    b.onclick = function () { dlg.showModal(); };
  });

  /* copy buttons */
  document.querySelectorAll('.cmd button').forEach(function (b) {
    b.onclick = function () {
      var t = b.parentNode.querySelector('code').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
        function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); },
        function () { b.textContent = 'Select it'; });
    };
  });
})();

/* The demo's play button: starts the film and steps aside. */
document.querySelectorAll('.play').forEach(function (box) {
  var v = box.querySelector('video'), b = box.querySelector('.playbtn');
  if (!v || !b) return;
  b.addEventListener('click', function () { box.classList.add('on'); v.play(); });
  v.addEventListener('play', function () { box.classList.add('on'); });
});

  /* Every film says what it is: invented data, scripted agents. */
  document.querySelectorAll('video.demo').forEach(function (v) {
    var n = document.createElement('p'); n.className = 'film-note'; n.textContent = 'Demo: invented data, scripted agents.';
    var box = v.closest('.play');
    if (box) box.appendChild(n); else v.insertAdjacentElement('afterend', n);
  });
  /* The changing words of the home subtitle: ONE pass of under 5 s, then they stay on the last ones, which is also
     what shows without script or for people who ask for less motion. */
  document.querySelectorAll('[data-rotate]').forEach(function (box) {
    var words = box.children, last = words.length - 1, at = last;
    var fit = function () { box.style.width = words[at].getBoundingClientRect().width + 'px'; };
    var show = function (i) { words[at].classList.remove('on'); at = i; words[at].classList.add('on'); fit(); };
    fit();
    window.addEventListener('resize', fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    show(0);
    for (var i = 1; i <= last; i++) (function (n) { setTimeout(function () { show(n); }, n * 1600); })(i);
  });
